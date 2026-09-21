// No-follow filesystem primitives for sensitive draft storage.
//
// Path-based chmod/read helpers can follow a link swapped into place after a
// check. Opening the validated inode and operating through its handle keeps
// permission repair and reads bound to the object that was inspected. Ownership
// and symlink checks are what keep one user's drafts out of another's reach on a
// shared machine or a network home.

import { constants, type Stats } from 'node:fs'
import { type FileHandle, link, lstat, mkdir, open, realpath, rm, stat, unlink } from 'node:fs/promises'
import path from 'node:path'

export const PRIVATE_DIR_MODE = 0o700
export const PRIVATE_FILE_MODE = 0o600

const MAX_QUARANTINE_ATTEMPTS = 1000
const NO_FOLLOW_FLAG = constants.O_NOFOLLOW ?? 0
const DIRECTORY_FLAG = constants.O_DIRECTORY ?? 0
const ROOT_UID = 0
const WORLD_WRITABLE_MODE = 0o002
const GROUP_WRITABLE_MODE = 0o020
const STICKY_MODE = 0o1000
const UNTRUSTED_ANCESTOR_MESSAGE =
  'is writable by other users, so a stash kept there could be redirected to another directory by anyone on this machine'

type FileIdentity = Pick<Stats, 'dev' | 'ino'>

export interface PrivateTextFile {
  readonly text: string
  readonly identity: FileIdentity
}

/** Where a quarantined file went, and whether that location reached the disk. */
export interface QuarantineResult {
  readonly path: string
  /** Set when the directory naming the copy could not be synced. */
  readonly syncError: unknown
}

/** A file that exceeded the caller's byte budget, which is a refusal, not corruption. */
export class FileTooLargeError extends Error {
  constructor(label: string) {
    super(`${label} is too large`)
    this.name = 'FileTooLargeError'
  }
}

/**
 * Prepare the storage directory, returning what a durable save still has to sync.
 *
 * The returned paths are the directories that name a newly created child. They
 * are not synced here, because a sync that fails before the rename would report a
 * failure for a directory that now exists, and the retry would find nothing left
 * to sync and could report success for an entry that never reached the disk. The
 * caller syncs them after the write commits, where a failure is a warning about
 * durability rather than a lost draft.
 */
export async function ensurePrivateDirectory(directory: string, label = 'storage directory'): Promise<string[]> {
  await assertTrustedAncestors(directory, label)
  const created = await createPrivateDirectory(directory)
  const handle = await openValidatedDirectory(directory, label)
  try {
    await handle.chmod(PRIVATE_DIR_MODE)
    await handle.sync()
  } finally {
    await handle.close()
  }
  // A directory that names a new child holds the only record of that child, so
  // the caller has to sync every directory this call created through its parent.
  return created
}

/** Create the directory chain, returning the directories that name something new. */
async function createPrivateDirectory(directory: string): Promise<string[]> {
  const missing: string[] = []
  let current = path.resolve(directory)
  for (;;) {
    if (await pathExists(current)) break
    missing.push(current)
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIR_MODE })
  // Deepest first, and only the directories that already existed: syncing a
  // directory that was itself just created happens on the next step of the walk.
  return missing.map(entry => path.dirname(entry))
}

/**
 * Refuse a storage path that anyone but this user (or root) can rewrite.
 *
 * Opening the storage directory without following a link protects that one
 * component, but an ancestor that another user can write is enough to rename the
 * directory underneath it and hand every later open somewhere else. The writable
 * bit that matters is any bit but the owner's: a group member can rename an entry
 * just as a stranger can, so only the sticky bit — which reserves renaming to the
 * entry's owner — makes a shared directory acceptable.
 *
 * Links are followed on purpose, because a link like macOS's `/tmp` is not a
 * threat and the permissions of what it resolves to are what count. That also
 * means the resolved chain has to be checked: a private directory reached through
 * a link can still sit under a directory other users can write, and resolving the
 * deepest part that exists is what names that chain.
 */
async function assertTrustedAncestors(directory: string, label: string): Promise<void> {
  const currentUid = process.getuid?.()
  const resolved = path.resolve(directory)
  const checked = new Set<string>()
  let deepestExisting: string | undefined
  for (let current = resolved; ; ) {
    let stats: Stats
    try {
      stats = await stat(current)
    } catch (error) {
      // A directory that is not there yet is created by the caller; its
      // ancestors still have to be checked, so a miss is not a failure here.
      if (hasErrorCode(error, 'ENOENT')) {
        const parent = path.dirname(current)
        if (parent === current) break
        current = parent
        continue
      }
      throw error
    }
    assertTrustedStats(stats, current, label, currentUid)
    checked.add(current)
    deepestExisting ??= current
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  if (deepestExisting === undefined) return
  let target: string
  try {
    target = await realpath(deepestExisting)
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return
    throw error
  }
  for (let current = target; !checked.has(current); ) {
    let stats: Stats
    try {
      stats = await stat(current)
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return
      throw error
    }
    assertTrustedStats(stats, current, label, currentUid)
    const parent = path.dirname(current)
    if (parent === current) return
    current = parent
  }
}

function assertTrustedStats(stats: Stats, directory: string, label: string, currentUid: number | undefined): void {
  if (currentUid !== undefined && stats.uid !== currentUid && stats.uid !== ROOT_UID) {
    throw new Error(`${label} at ${directory} is owned by another user`)
  }
  const shared = stats.mode & (WORLD_WRITABLE_MODE | GROUP_WRITABLE_MODE)
  if (shared !== 0 && (stats.mode & STICKY_MODE) === 0) {
    throw new Error(`${label} at ${directory} ${UNTRUSTED_ANCESTOR_MESSAGE}`)
  }
}

/**
 * Flush one directory entry without asserting who owns the directory.
 *
 * An ancestor may legitimately be root-owned (`/tmp`, a mount point) and still
 * have to be synced for the entry below it to survive a power loss, so the
 * ownership rule that guards the storage directory itself is not applied here.
 * A directory that is already gone needs no flushing.
 */
export async function syncDirectoryEntry(directory: string): Promise<void> {
  let handle: FileHandle
  try {
    handle = await open(directory, constants.O_RDONLY | DIRECTORY_FLAG)
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return
    throw error
  }
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function assertPrivateDirectory(directory: string, label: string): Promise<Stats> {
  const handle = await openValidatedDirectory(directory, label)
  try {
    return await handle.stat()
  } finally {
    await handle.close()
  }
}

export async function syncPrivateDirectory(directory: string, label = 'storage directory'): Promise<void> {
  const handle = await openValidatedDirectory(directory, label)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function readPrivateTextFile(
  filePath: string,
  label = 'stash file',
  maxBytes?: number,
): Promise<PrivateTextFile> {
  const before = await lstat(filePath)
  assertRegularOwnedFile(before, label)
  const handle = await open(filePath, constants.O_RDONLY | NO_FOLLOW_FLAG)
  try {
    const opened = await handle.stat()
    assertRegularOwnedFile(opened, label)
    assertSameIdentity(before, opened, label)
    await handle.chmod(PRIVATE_FILE_MODE)
    return { text: await readText(handle, maxBytes, label), identity: identityOf(opened) }
  } finally {
    await handle.close()
  }
}

async function readText(handle: FileHandle, maxBytes: number | undefined, label: string): Promise<string> {
  if (maxBytes === undefined) return handle.readFile('utf8')
  const buffer = Buffer.alloc(maxBytes + 1)
  let bytesRead = 0
  while (bytesRead < buffer.length) {
    const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, null)
    if (chunk.bytesRead === 0) break
    bytesRead += chunk.bytesRead
  }
  if (bytesRead > maxBytes) throw new FileTooLargeError(label)
  return buffer.subarray(0, bytesRead).toString('utf8')
}

export async function writePrivateFileExclusive(filePath: string, data: string | Uint8Array): Promise<void> {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW_FLAG
  const handle = await open(filePath, flags, PRIVATE_FILE_MODE)
  let succeeded = false
  try {
    await handle.writeFile(data)
    await handle.chmod(PRIVATE_FILE_MODE)
    await handle.sync()
    succeeded = true
  } finally {
    await handle.close()
    if (!succeeded) await rm(filePath, { force: true })
  }
}

/**
 * Move a file aside without losing it.
 *
 * A hard-link reservation keeps the original bytes reachable under a new name
 * before the source is unlinked, so an interrupted quarantine leaves either the
 * readable original or the readable copy, never neither.
 */
export async function quarantinePrivateFile(
  filePath: string,
  identity: FileIdentity,
  label: string,
  syncDirectory: typeof syncPrivateDirectory = syncPrivateDirectory,
): Promise<QuarantineResult> {
  for (let attempt = 0; attempt < MAX_QUARANTINE_ATTEMPTS; attempt += 1) {
    const candidate = `${filePath}.${label}${attempt === 0 ? '' : `-${attempt}`}`
    try {
      await link(filePath, candidate)
    } catch (error) {
      if (hasErrorCode(error, 'EEXIST')) continue
      throw error
    }
    let moved = false
    try {
      const candidateStats = await lstat(candidate)
      const sourceStats = await lstat(filePath)
      assertSameIdentity(candidateStats, identity, 'quarantine source')
      assertSameIdentity(sourceStats, identity, 'quarantine source')
      await unlink(filePath)
      moved = true
      try {
        await syncDirectory(path.dirname(filePath))
      } catch (error) {
        // The bytes are already under the recovery name and the original is
        // gone, so the path is the one thing the reader must still be told.
        // Throwing here would lose it and leave the next read starting empty
        // with no notice at all.
        return { path: candidate, syncError: error }
      }
      return { path: candidate, syncError: undefined }
    } finally {
      if (!moved) await unlink(candidate).catch(() => undefined)
    }
  }
  throw new Error(`unable to reserve quarantine path for ${filePath}`)
}

export async function removePrivateDirectory(directory: string, label = 'storage directory'): Promise<void> {
  let stats: Stats
  try {
    stats = await lstat(directory)
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return
    throw error
  }
  assertDirectory(stats, label)
  assertCurrentUserOwns(stats, label)
  await rm(directory, { recursive: true })
  await syncPrivateDirectory(path.dirname(directory))
}

async function openValidatedDirectory(directory: string, label: string): Promise<FileHandle> {
  const before = await lstat(directory)
  assertDirectory(before, label)
  assertCurrentUserOwns(before, label)
  const handle = await open(directory, constants.O_RDONLY | DIRECTORY_FLAG | NO_FOLLOW_FLAG)
  try {
    const opened = await handle.stat()
    assertDirectory(opened, label)
    assertCurrentUserOwns(opened, label)
    assertSameIdentity(before, opened, label)
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}

function assertDirectory(stats: Stats, label: string): void {
  if (stats.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`)
  if (!stats.isDirectory()) throw new Error(`${label} must be a directory`)
}

export function assertRegularOwnedFile(stats: Stats, label: string): void {
  if (stats.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`)
  if (!stats.isFile()) throw new Error(`${label} must be a regular file`)
  assertCurrentUserOwns(stats, label)
}

function assertCurrentUserOwns(stats: Stats, label: string): void {
  const currentUid = process.getuid?.()
  if (currentUid !== undefined && stats.uid !== currentUid) {
    throw new Error(`${label} must be owned by the current user`)
  }
}

function assertSameIdentity(actual: FileIdentity, expected: FileIdentity, label: string): void {
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error(`${label} changed during validation`)
  }
}

function identityOf(stats: Stats): FileIdentity {
  return { dev: stats.dev, ino: stats.ino }
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target)
    return true
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return false
    throw error
  }
}

export function hasErrorCode(value: unknown, code: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    (value as { code: unknown }).code === code
  )
}
