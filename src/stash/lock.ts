// Private cross-process lock for one stash file.
//
// Two `dsh --profile tui` runs can share a working directory, so every read that
// feeds a write and every write itself happens under an exclusive directory
// lock to coordinate access and reduce lost updates from read-modify-write races.
// Ownership is recorded in the lock so a lock left by a crashed process is
// reclaimed rather than wedging the bank forever.
//
// Release moves the directory aside before checking ownership to avoid deleting
// through the acquisition path. Reclaimers use a separate claim and recheck the
// observed identity to reject visible replacements. That claim serializes only
// reclaimers; the final check and pathname removal are not atomic with release
// or acquisition, so they cannot guarantee a successor is untouched.

import { createHash } from 'node:crypto'
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

// Space contention polls to limit filesystem work while still noticing a released lock.
const LOCK_RETRY_MS = 25
// Bound contention waits for stash commands; filesystem operations can outlast this deadline.
const LOCK_TIMEOUT_MS = 2000
// Allow incomplete owner publication before recovery, not a lease on a validated live owner.
const LOCK_STALE_MS = 30_000
const LOCK_OWNER_FILE = 'owner.json'
const LOCK_TAKEOVER_SUFFIX = '.taken'
/**
 * The name reclaimers link their claim file onto, so exactly one of them wins.
 *
 * Bank-derived claim names avoid one shared recovery claim for all working
 * directories in storage. A digest leaves room for suffixes and tokens even
 * when the bank key reaches the sanitizer's limit.
 */
const RECLAIM_PREFIX = '.claim-'
// Truncation leaves room for claim tokens in filenames, at the cost of possible cross-bank collisions.
const RECLAIM_DIGEST_LENGTH = 16
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

/** Serialize reads that may quarantine the bank with mutations, so recovery cannot race a writer. */
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
    // Preserve the completed read, including any quarantine path, rather than
    // discard its result over cleanup. A leftover lock can still block writers:
    // reclamation refuses an owner whose local PID remains alive.
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
        // Losing the name while publishing it is a retry, not a failure: a
        // contender that judged a lock abandoned can take the name away, and the
        // owner write then either finds the name gone or finds a successor's
        // owner file. Deleting the directory in either case would be deleting a
        // lock this process never held, and the successor would lose its turn.
        if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'EEXIST')) {
          if (Date.now() >= deadline) throw lockTimeout(lockDir)
          continue
        }
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

/**
 * The claim a reclaimer takes, named after the bank whose lock it guards.
 *
 * Exported because it is the path a timeout tells the reader to clear by hand.
 */
export function reclaimMutexPath(lockDir: string): string {
  const digest = createHash('sha256').update(path.basename(lockDir), 'utf8').digest('hex')
  return path.join(path.dirname(lockDir), `${RECLAIM_PREFIX}${digest.slice(0, RECLAIM_DIGEST_LENGTH)}`)
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
 * A mismatched token does not authorize deleting the displaced directory. If
 * restoration fails, preserve it and report the failure rather than destroy
 * another owner's record. This cannot exclude a successor at the original path.
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
 * Owner bytes alone cannot distinguish a released directory from its replacement.
 * Identity and token let reclaimers reject a changed observation before removal;
 * they do not make the later pathname deletion atomic with that check.
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
 * The claim serializes reclaimers so they cannot independently judge and remove
 * the same lock. Rechecking identity and token rejects replacements visible
 * before deletion, but acquisition and release do not take this claim: it cannot
 * exclude a replacement between the final check and pathname removal.
 *
 * A reclaimer killed inside that section leaves the claim file behind, and every
 * later reclaim fails closed at the timeout instead of guessing. That message
 * names the file so an operator can locate the obstruction. Manual cleanup must
 * account for active reclaimers; deleting their claim would break coordination.
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
    // Best-effort cleanup preserves the reclaim outcome. A leftover mutex still
    // blocks later reclamation and requires the manual recovery described above.
    await rm(claim, { force: true }).catch(() => undefined)
    await rm(mutex, { force: true }).catch(() => undefined)
  }
}

/**
 * Reject a replacement visible when rechecking the abandoned-lock observation.
 *
 * Identity and token checks reduce stale-observation deletion; they cannot
 * exclude replacement after the check because removal still uses the pathname.
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
  // Missing or malformed ownership cannot support a PID check. Directory age
  // gives a newly created lock time to publish its owner; it is a grace period,
  // not proof that publication cannot be delayed beyond it.
  // A local PID probe cannot establish whether an owner on another host exited.
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
    // Preserve the link outcome: EEXIST means another reclaimer holds the claim.
    // Cleanup failure may leave this contender's private file behind.
    await rm(claim, { force: true }).catch(() => undefined)
    if (hasErrorCode(error, 'EEXIST')) return undefined
    throw error
  }
}
