// Private cross-process lock for one stash file.
//
// Two `dsh --profile tui` runs can share a working directory, so every read that
// feeds a write and every write itself happens under an exclusive directory
// lock: none of them can lose another's entry to a read-modify-write race.
// Ownership is recorded in the lock so a lock left by a crashed process is
// reclaimed rather than wedging the bank forever.
//
// Reclaiming and releasing both *move* the lock out of its path with one atomic
// rename before they judge or delete it. Deleting or emptying the path directly
// would let a contender that paused mid-reclaim remove a lock another process
// had just published, and two writers would then run at once.

import { mkdir, rename, rm } from 'node:fs/promises'
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
    throw releaseError
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
  return new Error(`timed out waiting for the stash lock at ${lockDir}`)
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
 * A fresh lock at the original path means this one can never be restored, so the
 * moved directory is dropped instead of littering; whoever held it will see a
 * changed lock on release, which is a warning rather than a lost draft.
 */
async function putBackLockDirectory(taken: string, lockDir: string): Promise<void> {
  try {
    await rename(taken, lockDir)
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return
    await rm(taken, { force: true, recursive: true }).catch(() => undefined)
  }
}

/**
 * Whether a lock can be taken from a process that no longer holds it.
 *
 * A missing owner file means the holder may still be between `mkdir` and its
 * owner write, so it is reclaimable only once the directory itself is stale;
 * the same applies to a malformed owner. A foreign host is never provable, so
 * it stays held and the contender fails closed at the timeout.
 */
async function isReclaimableLock(lockDirectory: string, owner: LockOwner | undefined): Promise<boolean> {
  let stats: Awaited<ReturnType<typeof assertPrivateDirectory>>
  try {
    stats = await assertPrivateDirectory(lockDirectory, 'stash lock')
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return false
    throw error
  }
  if (owner === undefined) return Date.now() - stats.mtimeMs > LOCK_STALE_MS
  if (owner.host !== hostname()) return false
  return !processIsAlive(owner.pid)
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
 * Take a lock whose owner is gone.
 *
 * A live lock is never even moved: the first look decides, and only a lock that
 * already looks abandoned is taken out of its path. The look is then repeated on
 * the directory that was actually moved, so a lock published in between is put
 * straight back instead of being deleted — the removal always applies to the
 * same directory the judgement did.
 */
async function reclaimAbandonedLock(lockDir: string): Promise<boolean> {
  const observed = await readLockOwner(lockDir)
  if (!(await isReclaimableLock(lockDir, observed))) return false
  const taken = await takeLockDirectory(lockDir)
  if (taken === undefined) return false
  const movedOwner = await readLockOwner(taken)
  if ((movedOwner?.token ?? undefined) !== (observed?.token ?? undefined)) {
    await putBackLockDirectory(taken, lockDir)
    return false
  }
  await removePrivateDirectory(taken, 'stash lock')
  return true
}
