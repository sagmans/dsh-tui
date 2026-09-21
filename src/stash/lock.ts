// Private cross-process lock for one stash file.
//
// Two `dsh --profile tui` runs can share a working directory, so every read that
// feeds a write and every write itself happens under an exclusive directory
// lock: none of them can lose another's entry to a read-modify-write race.
// Ownership is recorded in the lock so a lock left by a crashed process is
// reclaimed rather than wedging the bank forever.
//
// Releasing *moves* the lock out of its path with one atomic rename before it
// judges or deletes it, and reclaiming judges a lock and removes it under a
// separate claim that only one contender can take. Removing the path on the
// strength of an earlier look would let a contender delete the live lock that
// replaced the one it judged, and two writers would then run at once.

import { link, mkdir, rename, rm } from 'node:fs/promises'
import { hostname } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import {
  assertPrivateDirectory,
  ensurePrivateDirectory,
  hasErrorCode,
  PRIVATE_DIR_MODE,
  readPrivateTextFile,
  removePrivateDirectory,
  writePrivateFileExclusive,
} from './private-fs.ts'
import { createNewId } from './schema.ts'

const LOCK_RETRY_MS = 25
const LOCK_TIMEOUT_MS = 2000
const LOCK_STALE_MS = 30_000
const LOCK_OWNER_FILE = 'owner.json'
const LOCK_TAKEOVER_SUFFIX = '.taken'
/**
 * The name reclaimers link their claim file onto, so exactly one of them wins.
 *
 * It sits beside the lock rather than in the lock's own name: the name is fixed
 * and short, so a key at the sanitizer's limit cannot push the claim past the
 * longest name a filesystem accepts.
 */
const RECLAIM_MUTEX_FILE = '.reclaiming'
const LOCK_CHANGED_MESSAGE = 'stash lock changed before release'

/** Which step failed after a write already committed, so the loss is never implied. */
export type StashFailurePhase = 'directory-sync' | 'lock-release'

export interface StashFailure {
  readonly phase: StashFailurePhase
  readonly error: unknown
}

/**
 * A mutation that landed on disk while a later step failed.
 *
 * The write is not undone — reporting it as a failure would tell the reader
 * their draft was lost when it is readable — so the failure travels beside the
 * result and the caller reports success plus the warning.
 */
export class StashCommittedError<Result = unknown> extends Error {
  readonly committed = true
  readonly result: Result
  readonly failure: StashFailure
  /** Set when the lock could not be released either, so both are reported. */
  readonly releaseFailure: StashFailure | undefined

  constructor(result: Result, failure: StashFailure, releaseFailure?: StashFailure) {
    super(
      releaseFailure === undefined
        ? `stash mutation committed but ${failure.phase} failed`
        : `stash mutation committed but ${failure.phase} and ${releaseFailure.phase} failed`,
      { cause: failure.error },
    )
    this.name = 'StashCommittedError'
    this.result = result
    this.failure = failure
    this.releaseFailure = releaseFailure
  }
}

export interface StashMutationResult<Result> {
  readonly didPersist: boolean
  readonly result: Result
}

interface LockOwner {
  readonly pid: number
  readonly host: string
  readonly token: string
  readonly createdAt: string
}

/** Take the file lock for a read that must not observe a half-written file. */
export function withStashFileLock<Result>(filePath: string, operation: () => Promise<Result>): Promise<Result> {
  return withStashLock(filePath, operation, false)
}

/**
 * Take the lock for a mutation, and classify an unlock failure as committed.
 *
 * Only a callback that reports `didPersist` turns a failed unlock into a
 * committed error: an unlock failure after a refused mutation is an ordinary
 * failure.
 */
export async function withStashMutationLock<Result>(
  filePath: string,
  operation: () => Promise<StashMutationResult<Result>>,
): Promise<Result> {
  const outcome = await withStashLock(filePath, operation, true)
  return outcome.result
}

async function withStashLock<Result>(
  filePath: string,
  operation: () => Promise<Result>,
  mutation: boolean,
): Promise<Result> {
  await ensurePrivateDirectory(path.dirname(filePath))
  const lockDir = `${filePath}.lock`
  const owner = await acquireStashLock(lockDir)
  let result: Result
  try {
    result = await operation()
  } catch (operationError) {
    try {
      await releaseStashLock(lockDir, owner)
    } catch (releaseError) {
      if (operationError instanceof StashCommittedError) {
        // The mutation is on disk, and the caller has to keep hearing that: an
        // AggregateError would read as a plain failure, and a retry of an
        // index-based drop would then delete the draft that followed the one
        // already removed. Both failed steps travel on the committed error.
        throw new StashCommittedError(operationError.result, operationError.failure, {
          phase: 'lock-release',
          error: releaseError,
        })
      }
      throw new AggregateError([operationError, releaseError], 'stash operation and lock release both failed')
    }
    throw operationError
  }
  try {
    await releaseStashLock(lockDir, owner)
  } catch (releaseError) {
    if (mutation && isPersistedMutation(result)) {
      throw new StashCommittedError(result.result, { phase: 'lock-release', error: releaseError })
    }
    // A read already has its answer, and the answer cannot be wrong because the
    // lock outlived it: the next contender reclaims a lock whose owner is gone.
    // Failing here would throw away what the caller just learned — including the
    // path of a bank that was quarantined while it was being read.
    if (mutation) throw releaseError
  }
  return result
}

function isPersistedMutation(value: unknown): value is StashMutationResult<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'didPersist' in value &&
    value.didPersist === true &&
    'result' in value
  )
}

async function acquireStashLock(lockDir: string): Promise<LockOwner> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    try {
      await mkdir(lockDir, { mode: PRIVATE_DIR_MODE })
      try {
        await assertPrivateDirectory(lockDir, 'stash lock')
        return await writeLockOwner(lockDir)
      } catch (error) {
        // A contender that judged this lock abandoned can take it while it is
        // still being published, so losing the directory here is a retry rather
        // than a failure to hold a lock this process never finished taking.
        if (hasErrorCode(error, 'ENOENT')) {
          if (Date.now() >= deadline) throw lockTimeout(lockDir)
          continue
        }
        await rm(lockDir, { force: true, recursive: true })
        throw error
      }
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) throw error
      try {
        await assertPrivateDirectory(lockDir, 'stash lock')
      } catch (validationError) {
        if (hasErrorCode(validationError, 'ENOENT')) continue
        throw validationError
      }
      if (await reclaimAbandonedLock(lockDir)) continue
      if (Date.now() >= deadline) throw lockTimeout(lockDir)
      await delay(LOCK_RETRY_MS)
    }
  }
}

function lockTimeout(lockDir: string): Error {
  const mutex = reclaimMutexPath(lockDir)
  return new Error(
    `timed out waiting for the stash lock at ${lockDir}; remove it and ${mutex} once no surface is running`,
  )
}

/** The claim a reclaimer takes, which lives beside the lock under a fixed name. */
function reclaimMutexPath(lockDir: string): string {
  return path.join(path.dirname(lockDir), RECLAIM_MUTEX_FILE)
}

async function writeLockOwner(lockDir: string): Promise<LockOwner> {
  const owner: LockOwner = {
    pid: process.pid,
    host: hostname(),
    token: createNewId(),
    createdAt: new Date().toISOString(),
  }
  await writePrivateFileExclusive(path.join(lockDir, LOCK_OWNER_FILE), `${JSON.stringify(owner)}\n`)
  return owner
}

async function readLockOwner(lockDir: string): Promise<LockOwner | undefined> {
  let text: string
  try {
    await assertPrivateDirectory(lockDir, 'stash lock')
    text = (await readPrivateTextFile(path.join(lockDir, LOCK_OWNER_FILE), 'lock owner file')).text
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return undefined
    throw error
  }
  try {
    const value: unknown = JSON.parse(text)
    return isLockOwner(value) ? value : undefined
  } catch {
    return undefined
  }
}

function isLockOwner(value: unknown): value is LockOwner {
  return (
    typeof value === 'object' &&
    value !== null &&
    'pid' in value &&
    Number.isSafeInteger(value.pid) &&
    'host' in value &&
    typeof value.host === 'string' &&
    'token' in value &&
    typeof value.token === 'string' &&
    value.token.length > 0 &&
    'createdAt' in value &&
    typeof value.createdAt === 'string'
  )
}

async function releaseStashLock(lockDir: string, expected: LockOwner): Promise<void> {
  const taken = await takeLockDirectory(lockDir)
  if (taken === undefined) throw new Error(LOCK_CHANGED_MESSAGE)
  const owner = await readLockOwner(taken)
  if (owner?.token !== expected.token) {
    await putBackLockDirectory(taken, lockDir)
    throw new Error(LOCK_CHANGED_MESSAGE)
  }
  await removePrivateDirectory(taken, 'stash lock')
}

/**
 * Move the lock out of its path, so only this caller can act on what it finds.
 *
 * One rename is atomic: two contenders cannot both take the same lock, and a
 * lock published afterwards lands at the original path rather than under this
 * name. Nothing is ever deleted through the path a fresh lock would occupy.
 */
async function takeLockDirectory(lockDir: string): Promise<string | undefined> {
  const taken = `${lockDir}${LOCK_TAKEOVER_SUFFIX}.${createNewId()}`
  try {
    await rename(lockDir, taken)
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTEMPTY') || hasErrorCode(error, 'EEXIST')) {
      return undefined
    }
    throw error
  }
  return taken
}

/**
 * Put a lock back that turned out to belong to someone else.
 *
 * A fresh lock at the original path means this one can never be restored. It is
 * left where it is rather than deleted: whoever holds it is running, so a lock
 * that is merely hard to find costs a warning on release, while a deleted one
 * costs a second writer in the bank.
 */
async function putBackLockDirectory(taken: string, lockDir: string): Promise<void> {
  try {
    await rename(taken, lockDir)
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return
    throw error
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // Only ESRCH proves the process is gone; every other failure (permissions,
    // an unknown error) is uncertainty and must keep the lock held.
    return !hasErrorCode(error, 'ESRCH')
  }
}

/**
 * What a reclaim is allowed to act on: one reading of the lock, with the
 * identity of the directory it was read from.
 *
 * The owner bytes alone are not enough, because the directory that held them can
 * be released and replaced between the reading and the removal. A lock is only
 * removed when both the identity and the token still match what was judged.
 */
export interface LockObservation {
  readonly owner: LockOwner | undefined
  readonly device: number
  readonly inode: number
  readonly modified: number
}

/** Read a lock and the identity of the directory it was read from, in one pass. */
export async function observeLock(lockDir: string): Promise<LockObservation | undefined> {
  let stats: Awaited<ReturnType<typeof assertPrivateDirectory>>
  try {
    stats = await assertPrivateDirectory(lockDir, 'stash lock')
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return undefined
    throw error
  }
  const owner = await readLockOwner(lockDir)
  return { owner, device: stats.dev, inode: stats.ino, modified: stats.mtimeMs }
}

/**
 * Reclaim a lock whose owner is gone.
 *
 * Reclaimers serialize on a claim file created by link, which exactly one of
 * them can win, so only one of them ever judges and removes a given lock. The
 * winner looks once, decides from that look, and then removes only if the lock
 * still is the directory it looked at: a holder that released in between would
 * otherwise leave its successor's live lock to be deleted, and both writers
 * would then run at once.
 *
 * A reclaimer killed inside that section leaves the claim file behind, and every
 * later reclaim fails closed at the timeout instead of guessing. That message
 * names the file, because clearing it by hand is the one recovery that cannot
 * cost an update.
 */
async function reclaimAbandonedLock(lockDir: string): Promise<boolean> {
  const mutex = reclaimMutexPath(lockDir)
  const claim = await claimReclaim(mutex)
  if (claim === undefined) return false
  try {
    const observed = await observeLock(lockDir)
    if (observed === undefined || !isAbandonedLock(observed)) return false
    return await removeObservedLock(lockDir, observed)
  } finally {
    await rm(claim, { force: true }).catch(() => undefined)
    await rm(mutex, { force: true }).catch(() => undefined)
  }
}

/**
 * Remove the lock a judgement was made about, and nothing that replaced it.
 *
 * Exported so the race this exists for can be driven from a test: hold an
 * observation, publish a live lock in its place, and the removal has to refuse.
 */
export async function removeObservedLock(lockDir: string, observed: LockObservation): Promise<boolean> {
  const current = await observeLock(lockDir)
  if (current === undefined) return false
  if (current.device !== observed.device || current.inode !== observed.inode) return false
  if (current.owner?.token !== observed.owner?.token) return false
  await removePrivateDirectory(lockDir, 'stash lock')
  return true
}

/** Whether one observation of a lock shows an owner that can no longer hold it. */
function isAbandonedLock(observed: LockObservation): boolean {
  if (observed.owner === undefined) return Date.now() - observed.modified > LOCK_STALE_MS
  if (observed.owner.host !== hostname()) return false
  return !processIsAlive(observed.owner.pid)
}

/**
 * Win the right to reclaim, by linking a private claim file onto one name.
 *
 * `link` is the atomic test-and-set this needs: it fails when the name exists,
 * and it never replaces what is already there, so a contender that loses reads
 * the winner's claim rather than breaking it.
 */
async function claimReclaim(mutex: string): Promise<string | undefined> {
  const claim = `${mutex}.${createNewId()}`
  await writePrivateFileExclusive(claim, `${JSON.stringify({ pid: process.pid, host: hostname() })}\n`)
  try {
    await link(claim, mutex)
    return claim
  } catch (error) {
    await rm(claim, { force: true }).catch(() => undefined)
    if (hasErrorCode(error, 'EEXIST')) return undefined
    throw error
  }
}
