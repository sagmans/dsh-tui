import { mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { hostname } from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { StashCommittedError, withStashFileLock, withStashMutationLock } from '@/stash/lock.ts'
import { PRIVATE_DIR_MODE, writePrivateFileExclusive } from '@/stash/private-fs.ts'

const scratchDirs: string[] = []

function scratchFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-stash-lock-'))
  scratchDirs.push(directory)
  return join(directory, 'bank.json')
}

afterEach(() => {
  for (const directory of scratchDirs.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** Publish a lock as if another process held it, so the contender is exercised. */
async function holdLock(lockDir: string, owner: { pid: number; host: string }): Promise<void> {
  mkdirSync(lockDir, { mode: PRIVATE_DIR_MODE })
  await writePrivateFileExclusive(
    join(lockDir, 'owner.json'),
    `${JSON.stringify({ ...owner, token: 'foreign-token', createdAt: new Date().toISOString() })}\n`,
  )
}

/** Replace the owner of a held lock, which is what a release check must notice. */
async function stealLock(lockDir: string): Promise<void> {
  rmSync(join(lockDir, 'owner.json'), { force: true })
  await writePrivateFileExclusive(
    join(lockDir, 'owner.json'),
    `${JSON.stringify({ pid: 1, host: 'elsewhere', token: 'stolen', createdAt: new Date().toISOString() })}\n`,
  )
}

describe('withStashFileLock', () => {
  it('runs overlapping readers one at a time', async () => {
    const file = scratchFile()
    let active = 0
    let peak = 0
    await Promise.all(
      [0, 1, 2].map(async () => {
        await withStashFileLock(file, async () => {
          active += 1
          peak = Math.max(peak, active)
          await delay(15)
          active -= 1
        })
      }),
    )
    expect(peak).toBe(1)
  })

  it('reclaims a lock whose owner process is gone', async () => {
    const file = scratchFile()
    // A pid beyond the platform's range can never be running.
    await holdLock(`${file}.lock`, { pid: 2_147_483_646, host: hostname() })
    await expect(withStashFileLock(file, async () => 'ran')).resolves.toBe('ran')
  })

  it('reclaims a lock directory left with no owner, once it is stale', async () => {
    const file = scratchFile()
    const lockDir = `${file}.lock`
    mkdirSync(lockDir, { mode: PRIVATE_DIR_MODE })
    const old = new Date(Date.now() - 60_000)
    utimesSync(lockDir, old, old)
    await expect(withStashFileLock(file, async () => 'ran')).resolves.toBe('ran')
  })

  it('times out rather than breaking a lock a live owner still holds', async () => {
    const file = scratchFile()
    await holdLock(`${file}.lock`, { pid: process.pid, host: hostname() })
    await expect(withStashFileLock(file, async () => 'ran')).rejects.toThrow(/timed out waiting for the stash lock/)
  })

  it('refuses to release a lock that another holder replaced', async () => {
    const file = scratchFile()
    await expect(
      withStashFileLock(file, async () => {
        await stealLock(`${file}.lock`)
        return 'done'
      }),
    ).rejects.toThrow(/changed before release/)
  })
})

describe('withStashMutationLock', () => {
  it('unwraps the mutation result', async () => {
    const file = scratchFile()
    await expect(
      withStashMutationLock(file, async () => ({ didPersist: true, result: 'saved' })),
    ).resolves.toBe('saved')
  })

  it('reports a persisted mutation whose release failed as committed, never as lost', async () => {
    const file = scratchFile()
    const failure = withStashMutationLock(file, async () => {
      await stealLock(`${file}.lock`)
      return { didPersist: true, result: 'saved' }
    })
    await expect(failure).rejects.toBeInstanceOf(StashCommittedError)
    await failure.catch((error: StashCommittedError) => {
      expect(error.result).toBe('saved')
      expect(error.failure.phase).toBe('lock-release')
    })
  })

  it('keeps a committed mutation committed when the release fails too', async () => {
    const file = scratchFile()
    const failure = withStashMutationLock(file, async () => {
      await stealLock(`${file}.lock`)
      // The rename landed and only the directory sync failed, which is the
      // committed-but-warned case a second failure must not downgrade: a caller
      // that reads this as "nothing happened" retries a deletion that did.
      throw new StashCommittedError('saved', { phase: 'directory-sync', error: new Error('fsync failed') })
    })
    await expect(failure).rejects.toBeInstanceOf(StashCommittedError)
    await failure.catch((error: StashCommittedError) => {
      expect(error.result).toBe('saved')
      expect(error.failure.phase).toBe('directory-sync')
      expect(error.releaseFailure?.phase).toBe('lock-release')
    })
  })

  it('keeps a refused mutation an ordinary failure', async () => {
    const file = scratchFile()
    const failure = withStashMutationLock(file, async () => {
      await stealLock(`${file}.lock`)
      return { didPersist: false, result: undefined }
    })
    await expect(failure).rejects.toThrow(/changed before release/)
    await failure.catch((error: unknown) => expect(error).not.toBeInstanceOf(StashCommittedError))
  })
})
