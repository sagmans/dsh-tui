import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync } from 'node:fs'
import { hostname } from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { StashCommittedError, withStashFileLock, withStashMutationLock } from '@/stash/lock.ts'
import { PRIVATE_DIR_MODE, writePrivateFileExclusive } from '@/stash/private-fs.ts'

const scratchDirs: string[] = []
/** A pid beyond every platform's range, so it can never name a running process. */
const DEAD_PID = 2_147_483_646

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
    await holdLock(`${file}.lock`, { pid: DEAD_PID, host: hostname() })
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

  /**
   * A read that already produced its answer must keep it: a lock outliving the
   * read is recoverable, while throwing here would lose what the read learned —
   * including where a corrupt bank was quarantined.
   */
  it('keeps the read result when the lock cannot be released', async () => {
    const file = scratchFile()
    await expect(
      withStashFileLock(file, async () => {
        await stealLock(`${file}.lock`)
        return 'read'
      }),
    ).resolves.toBe('read')
  })

  it('reports a lock that cannot be released as a committed mutation, not a lost one', async () => {
    const file = scratchFile()
    await expect(
      withStashMutationLock(file, async () => {
        await stealLock(`${file}.lock`)
        return { didPersist: true, result: 'written' }
      }),
    ).rejects.toThrow(/mutation committed but lock-release failed/)
  })

  /**
   * Reclaiming is the one place a lock can be removed by a process that does not
   * hold it, so it is the place two contenders must not both get through: they
   * would each remove the other's fresh lock and both end up writing.
   */
  it('lets one reclaimer through when several find the same dead lock', async () => {
    const file = scratchFile()
    await holdLock(`${file}.lock`, { pid: DEAD_PID, host: hostname() })
    let active = 0
    let peak = 0
    await Promise.all(
      [0, 1, 2, 3].map(async () => {
        await withStashFileLock(file, async () => {
          active += 1
          peak = Math.max(peak, active)
          await delay(20)
          active -= 1
        })
      }),
    )
    expect(peak).toBe(1)
    expect(existsSync(`${file}.lock.reclaiming`)).toBe(false)
  })

  it('leaves a live lock exactly where it is while looking at it', async () => {
    const file = scratchFile()
    const lockDir = `${file}.lock`
    await holdLock(lockDir, { pid: process.pid, host: hostname() })
    const before = readFileSync(join(lockDir, 'owner.json'), 'utf8')
    await expect(withStashFileLock(file, async () => 'ran')).rejects.toThrow(/timed out waiting/)
    expect(readFileSync(join(lockDir, 'owner.json'), 'utf8')).toBe(before)
    expect(readdirSync(lockDir)).toEqual(['owner.json'])
  })

  /**
   * A reclaimer killed between winning the claim and clearing it is the one
   * state a reader has to resolve by hand, so the contender has to stop and say
   * which file is in the way rather than guess that nobody is reclaiming.
   */
  it('fails closed while a dead reclaimer still holds the claim', async () => {
    const file = scratchFile()
    const lockDir = `${file}.lock`
    await holdLock(lockDir, { pid: DEAD_PID, host: hostname() })
    const mutex = `${lockDir}.reclaiming`
    await writePrivateFileExclusive(mutex, `${JSON.stringify({ pid: DEAD_PID, host: hostname() })}\n`)
    await expect(withStashFileLock(file, async () => 'ran')).rejects.toThrow(/timed out waiting for the stash lock/)
    expect(existsSync(mutex)).toBe(true)
    expect(existsSync(lockDir)).toBe(true)
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
