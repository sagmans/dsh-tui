import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync } from 'node:fs'
import { hostname } from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import {
  observeLock,
  reclaimMutexPath,
  removeObservedLock,
  StashCommittedError,
  withStashFileLock,
  withStashMutationLock,
} from '@/stash/lock.ts'
import { PRIVATE_DIR_MODE, writePrivateFileExclusive } from '@/stash/private-fs.ts'

/** The sanitizer's limit for a generated key, which the lock names must survive. */
const SANITIZE_MAX_LENGTH = 200

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
async function holdLock(
  lockDir: string,
  owner: { pid: number; host: string },
  token = 'foreign-token',
): Promise<void> {
  mkdirSync(lockDir, { mode: PRIVATE_DIR_MODE })
  await writePrivateFileExclusive(
    join(lockDir, 'owner.json'),
    `${JSON.stringify({ ...owner, token, createdAt: new Date().toISOString() })}\n`,
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
   * A contender never removes a lock it does not hold: a publisher that lost the
   * name to a successor has to walk away from it, because the successor's lock is
   * the one keeping two writers out of the bank.
   */
  it('leaves a live lock alone when publishing loses the name', async () => {
    const file = scratchFile()
    const lockDir = `${file}.lock`
    // The name is already taken by a live successor when the owner write runs.
    await holdLock(lockDir, { pid: process.pid, host: hostname() })
    const before = readFileSync(join(lockDir, 'owner.json'), 'utf8')
    await expect(withStashFileLock(file, async () => 'ran')).rejects.toThrow(/timed out waiting/)
    expect(readFileSync(join(lockDir, 'owner.json'), 'utf8')).toBe(before)
    expect(existsSync(lockDir)).toBe(true)
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
   * The race a reclaimer has to lose: an owner releases between the look and the
   * removal, and the name is taken by a live lock before the removal lands. The
   * observation is the barrier — the replacement is published between the two
   * calls — so a removal that trusts its earlier look deletes a running holder.
   *
   * The successor's token is what a release can never keep, so it is the token
   * that answers here; a filesystem is free to hand the same inode straight back.
   */
  it('refuses to remove a lock whose owner was replaced', async () => {
    const file = scratchFile()
    const lockDir = `${file}.lock`
    await holdLock(lockDir, { pid: DEAD_PID, host: hostname() })
    const observed = await observeLock(lockDir)
    expect(observed).toBeDefined()

    rmSync(lockDir, { recursive: true })
    await holdLock(lockDir, { pid: process.pid, host: hostname() }, 'successor-token')
    const replacement = readFileSync(join(lockDir, 'owner.json'), 'utf8')

    await expect(removeObservedLock(lockDir, observed!)).resolves.toBe(false)
    expect(readFileSync(join(lockDir, 'owner.json'), 'utf8')).toBe(replacement)
  })

  /**
   * The token on its own: an observation whose identity still matches the
   * directory in place, so nothing but the owner it names can refuse. A
   * filesystem may hand a released lock's inode straight back to its successor,
   * which is exactly the case a comparison that stopped at identity would miss.
   */
  it('refuses a lock whose identity matches but whose owner token does not', async () => {
    const file = scratchFile()
    const lockDir = `${file}.lock`
    await holdLock(lockDir, { pid: DEAD_PID, host: hostname() })
    const observed = await observeLock(lockDir)
    expect(observed).toBeDefined()

    const judged = { ...observed!, owner: { ...observed!.owner!, token: 'judged-token' } }
    await expect(removeObservedLock(lockDir, judged)).resolves.toBe(false)
    expect(existsSync(lockDir)).toBe(true)
  })

  /**
   * A lock that replaced the judged one without sharing its token: the directory
   * is renamed aside rather than deleted, so its inode stays allocated and the
   * replacement cannot be mistaken for it. Identity is the only thing left that
   * can refuse, which is what makes this the check's own test.
   */
  it('refuses to remove a different directory at the same name', async () => {
    const file = scratchFile()
    const lockDir = `${file}.lock`
    await holdLock(lockDir, { pid: DEAD_PID, host: hostname() })
    const observed = await observeLock(lockDir)
    expect(observed).toBeDefined()

    renameSync(lockDir, `${lockDir}.judged`)
    await holdLock(lockDir, { pid: process.pid, host: hostname() })
    const replacement = readFileSync(join(lockDir, 'owner.json'), 'utf8')

    await expect(removeObservedLock(lockDir, observed!)).resolves.toBe(false)
    expect(readFileSync(join(lockDir, 'owner.json'), 'utf8')).toBe(replacement)
  })

  /**
   * Reclaim names are fixed rather than derived from the key, because a key at
   * the sanitizer's limit plus a suffix and a token is longer than the longest
   * name a filesystem accepts: recovery would fail exactly where it is needed.
   */
  it('reclaims a lock for a key at the length limit', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-stash-lock-'))
    scratchDirs.push(directory)
    const file = join(directory, `${'k'.repeat(SANITIZE_MAX_LENGTH)}.json`)
    await holdLock(`${file}.lock`, { pid: DEAD_PID, host: hostname() })
    await expect(withStashFileLock(file, async () => 'ran')).resolves.toBe('ran')
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
    // Every winner clears its claim, so nothing is left to fail the next reclaim.
    expect(existsSync(reclaimMutexPath(`${file}.lock`))).toBe(false)
    expect(readdirSync(join(file, '..')).filter(name => name.startsWith('.claim-'))).toEqual([])
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
    const mutex = reclaimMutexPath(lockDir)
    await writePrivateFileExclusive(mutex, `${JSON.stringify({ pid: DEAD_PID, host: hostname() })}\n`)
    await expect(withStashFileLock(file, async () => 'ran')).rejects.toThrow(/timed out waiting for the stash lock/)
    expect(existsSync(mutex)).toBe(true)
    expect(existsSync(lockDir)).toBe(true)
  })

  /**
   * One storage directory holds a bank per working directory, so a claim left by
   * a crashed reclaimer has to stop recovery for the bank it guards and no other.
   */
  it('keeps a stuck claim from stopping recovery for another bank', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-stash-lock-'))
    scratchDirs.push(directory)
    const blocked = join(directory, 'one.json')
    const free = join(directory, 'two.json')
    await holdLock(`${blocked}.lock`, { pid: DEAD_PID, host: hostname() })
    await holdLock(`${free}.lock`, { pid: DEAD_PID, host: hostname() })
    await writePrivateFileExclusive(reclaimMutexPath(`${blocked}.lock`), '{"pid":1,"host":"elsewhere"}\n')

    await expect(withStashFileLock(free, async () => 'ran')).resolves.toBe('ran')
    expect(existsSync(reclaimMutexPath(`${blocked}.lock`))).toBe(true)
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
