// StashStore: on-disk CRUD for stash entries, scoped to one session.
//
// Entries are stored newest-first (`entries[0]` is `stash@{0}`), mirroring git's
// index-0-is-tip convention. Every mutation re-reads the file inside an
// exclusive lock so two surfaces in the same directory cannot lose updates to a
// read-modify-write race. Writes are atomic (exclusive temp + rename + directory
// fsync) with tight 0o600/0o700 permissions, because a stashed draft may hold
// anything the reader was about to send. A corrupt file is quarantined rather
// than overwritten, so a hand-edit mistake never silently destroys saved drafts.

import { rename, rm } from 'node:fs/promises'
import path from 'node:path'

import {
  StashCommittedError,
  withStashFileLock,
  withStashMutationLock,
  type StashFailurePhase,
  type StashMutationResult,
} from './lock.ts'
import type { StashPaths } from './paths.ts'
import {
  ensurePrivateDirectory,
  hasErrorCode,
  type PrivateTextFile,
  quarantinePrivateFile,
  readPrivateTextFile,
  syncDirectoryEntry,
  writePrivateFileExclusive,
} from './private-fs.ts'
import {
  assertSafeEntryId,
  assertSafeStashText,
  type Clock,
  createEmptyStashFile,
  createNewId,
  isRecord,
  parseStashFile,
  type ResolvedEntry,
  resolveBySelector,
  sanitizeStashText,
  STASH_SCHEMA_VERSION,
  type StashEntry,
  type StashFile,
} from './schema.ts'

/**
 * A stash file larger than this is refused, never quarantined: hiding a
 * legitimate bank because it grew past a cap would be worse than refusing it.
 */
export const MAX_STASH_FILE_BYTES = 16_777_216

const DUPLICATE_STASH_ID_MESSAGE = 'duplicate stash id'
const UNSUPPORTED_SCHEMA_GUIDANCE =
  'Upgrade dsh-tui before using this stash, or move the stash file aside for safe recovery.'
const FILE_TOO_LARGE_MESSAGE = 'this session has no room left for another draft; drop one first'

/**
 * A bank that cannot be written because it would no longer be readable.
 *
 * The cap is only useful if it is enforced before the write: a file that grows
 * past it is refused by every later read, so letting one save through would turn
 * a full bank into an unreadable one.
 */
export class StashFileTooLargeError extends Error {
  readonly bytes: number

  constructor(bytes: number) {
    super(FILE_TOO_LARGE_MESSAGE)
    this.name = 'StashFileTooLargeError'
    this.bytes = bytes
  }
}

export interface AddEntryInput {
  readonly text: string
  /** Caller-supplied id; generated when omitted. */
  readonly id?: string
  /** Caller-supplied timestamp, used only when a recovery path restores an entry. */
  readonly createdAt?: number
}

type LoadResult =
  | { kind: 'ready'; file: StashFile }
  | { kind: 'corrupt'; quarantinedTo: string | undefined; quarantineSyncFailed: boolean }
  | { kind: 'unsupported'; version: number }

/** Where a read moved an unreadable bank, and whether that move is durable. */
export interface QuarantineRecord {
  readonly path: string
  readonly syncFailed: boolean
}

export interface StashWriteOutcome {
  readonly committed: true
  readonly phase: StashFailurePhase
  readonly error: unknown
}

export type StashWriter = (
  filePath: string,
  file: StashFile,
  syncDirectory?: typeof syncDirectoryEntry,
  replaceFile?: typeof rename,
) => Promise<void | StashWriteOutcome>

/** Stash data written by a newer build, which this one must not touch. */
export class UnsupportedStashSchemaError extends Error {
  readonly detectedVersion: number
  readonly supportedVersion: number

  constructor(detectedVersion: number, supportedVersion: number = STASH_SCHEMA_VERSION) {
    super(
      `stash data uses version ${detectedVersion}; this build supports versions through ${supportedVersion}. ${UNSUPPORTED_SCHEMA_GUIDANCE}`,
    )
    this.name = 'UnsupportedStashSchemaError'
    this.detectedVersion = detectedVersion
    this.supportedVersion = supportedVersion
  }
}

export class StashStore {
  private file: StashFile
  private corruptRecovery: QuarantineRecord | undefined
  private readonly filePath: string
  private readonly paths: StashPaths
  private readonly now: Clock
  private readonly write: StashWriter

  constructor(paths: StashPaths, loaded: LoadResult, now: Clock = Date.now, write: StashWriter = writeStashFile) {
    this.paths = paths
    this.now = now
    this.write = write
    this.file = loaded.kind === 'ready' ? loaded.file : createEmptyStashFile(paths.sessionId, now())
    this.corruptRecovery =
      loaded.kind === 'corrupt' && loaded.quarantinedTo !== undefined
        ? { path: loaded.quarantinedTo, syncFailed: loaded.quarantineSyncFailed }
        : undefined
    this.filePath = paths.file
  }

  get entries(): readonly StashEntry[] {
    return this.file.entries
  }

  get entryCount(): number {
    return this.file.entries.length
  }

  /** The recovery location the last read produced, if any, reported once. */
  takeQuarantine(): QuarantineRecord | undefined {
    const recovery = this.corruptRecovery
    this.corruptRecovery = undefined
    return recovery
  }

  /** Resolve a selector against the entries currently held. */
  find(selector: string | undefined): ResolvedEntry | undefined {
    return resolveBySelector(this.file.entries, selector)
  }

  async refresh(): Promise<void> {
    await withStashFileLock(this.filePath, () => this.reloadFresh())
  }

  async add(input: AddEntryInput): Promise<ResolvedEntry> {
    const id = input.id ?? createNewId()
    assertSafeEntryId(id)
    assertSafeStashText(input.text)
    // A draft is stored in the form it is safe to draw again, so no path back to
    // the screen has to remember to strip it.
    const text = sanitizeStashText(input.text)
    return withStashMutationLock(this.filePath, async () => {
      await this.reloadFresh()
      if (this.file.entries.some(entry => entry.id === id)) throw new Error(DUPLICATE_STASH_ID_MESSAGE)
      const entry: StashEntry = { id, text, createdAt: input.createdAt ?? this.now() }
      const next: StashFile = {
        ...this.file,
        updatedAt: entry.createdAt,
        entries: [entry, ...this.file.entries],
      }
      return this.persistMutation(next, { entry, index: 0 })
    })
  }

  /** Remove one entry by its exact id, reporting what was removed. */
  async removeById(id: string): Promise<ResolvedEntry | undefined> {
    assertSafeEntryId(id)
    return withStashMutationLock(this.filePath, async () => {
      await this.reloadFresh()
      return this.removeAt(selector => selector === id)
    })
  }

  /** Remove the entry a selector names, reporting what was removed. */
  async drop(selector: string | undefined): Promise<ResolvedEntry | undefined> {
    return withStashMutationLock(this.filePath, async () => {
      await this.reloadFresh()
      const resolved = resolveBySelector(this.file.entries, selector)
      if (resolved === undefined) return { didPersist: false, result: undefined }
      const next: StashFile = {
        ...this.file,
        updatedAt: this.now(),
        entries: this.file.entries.filter((_, index) => index !== resolved.index),
      }
      return this.persistMutation(next, resolved)
    })
  }

  /**
   * Remove drafts, reporting how many were dropped.
   *
   * Ids restrict the removal to exactly what a reader confirmed. Clearing
   * whatever is on disk instead would delete drafts another surface added while
   * the confirmation was on screen, which is a loss nobody agreed to.
   */
  async clear(ids?: readonly string[]): Promise<number> {
    return withStashMutationLock(this.filePath, async () => {
      await this.reloadFresh()
      const confirmed = ids === undefined ? undefined : new Set(ids)
      const kept = confirmed === undefined ? [] : this.file.entries.filter(entry => !confirmed.has(entry.id))
      const removed = this.file.entries.length - kept.length
      if (removed === 0) return { didPersist: false, result: 0 }
      const next: StashFile = {
        ...createEmptyStashFile(this.paths.sessionId, this.now()),
        updatedAt: this.now(),
        entries: kept,
      }
      return this.persistMutation(next, removed)
    })
  }

  private async removeAt(match: (id: string) => boolean): Promise<StashMutationResult<ResolvedEntry | undefined>> {
    const index = this.file.entries.findIndex(entry => match(entry.id))
    const found = index < 0 ? undefined : this.file.entries[index]
    if (found === undefined) return { didPersist: false, result: undefined }
    const next: StashFile = {
      ...this.file,
      updatedAt: this.now(),
      entries: this.file.entries.filter((_, position) => position !== index),
    }
    return this.persistMutation(next, { entry: found, index })
  }

  private async persistMutation<Result>(next: StashFile, result: Result): Promise<StashMutationResult<Result>> {
    const outcome = await this.write(this.filePath, next)
    this.file = next
    if (outcome?.committed === true) {
      throw new StashCommittedError(result, { phase: outcome.phase, error: outcome.error })
    }
    return { didPersist: true, result }
  }

  private async reloadFresh(): Promise<void> {
    const loaded = await readCurrentStashFile(this.filePath, this.paths.sessionId, this.now())
    if (loaded.kind === 'ready') {
      this.file = loaded.file
      return
    }
    if (loaded.kind === 'unsupported') throw new UnsupportedStashSchemaError(loaded.version)
    // Corrupt input is quarantined and replaced in memory, so later writes
    // cannot resurrect entries from the invalidated snapshot.
    this.file = createEmptyStashFile(this.paths.sessionId, this.now())
    this.corruptRecovery =
      loaded.quarantinedTo === undefined
        ? undefined
        : { path: loaded.quarantinedTo, syncFailed: loaded.quarantineSyncFailed }
  }
}

export async function loadStashStore(
  paths: StashPaths,
  now: Clock = Date.now,
  write: StashWriter = writeStashFile,
): Promise<StashStore> {
  const loaded = await withStashFileLock(paths.file, () => readCurrentStashFile(paths.file, paths.sessionId, now()))
  if (loaded.kind === 'unsupported') throw new UnsupportedStashSchemaError(loaded.version)
  return new StashStore(paths, loaded, now, write)
}

async function readCurrentStashFile(filePath: string, sessionId: string, now: number): Promise<LoadResult> {
  let source: PrivateTextFile
  try {
    source = await readPrivateTextFile(filePath, 'stash file', MAX_STASH_FILE_BYTES)
  } catch (error) {
    // A missing bank is an empty one; an oversized or unreadable bank is a real
    // failure the caller must report rather than silently start over from.
    if (hasErrorCode(error, 'ENOENT')) return { kind: 'ready', file: createEmptyStashFile(sessionId, now) }
    throw error
  }

  let raw: unknown
  try {
    raw = JSON.parse(source.text)
  } catch {
    return await quarantineCorrupt(filePath, source.identity)
  }
  const parsed = parseStashFile(raw)
  if (parsed !== undefined && parsed.sessionId === sessionId) return { kind: 'ready', file: parsed }
  if (
    isRecord(raw) &&
    typeof raw.version === 'number' &&
    Number.isSafeInteger(raw.version) &&
    raw.version > STASH_SCHEMA_VERSION
  ) {
    return { kind: 'unsupported', version: raw.version }
  }
  return await quarantineCorrupt(filePath, source.identity)
}

async function quarantineCorrupt(
  filePath: string,
  identity: PrivateTextFile['identity'],
): Promise<LoadResult> {
  const quarantined = await quarantinePrivateFile(filePath, identity, `corrupt-${Date.now()}`)
  return { kind: 'corrupt', quarantinedTo: quarantined.path, quarantineSyncFailed: quarantined.syncError !== undefined }
}

export async function writeStashFile(
  filePath: string,
  file: StashFile,
  syncDirectory: typeof syncDirectoryEntry = syncDirectoryEntry,
  replaceFile: typeof rename = rename,
): Promise<void | StashWriteOutcome> {
  const directory = path.dirname(filePath)
  await ensurePrivateDirectory(directory)
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  const data = `${JSON.stringify(file, null, 2)}\n`
  // Every later read refuses a file past this cap, so a write that would cross
  // it has to be refused here instead: the alternative is a bank that saves
  // successfully, clears the editor, and can never be opened again.
  const bytes = Buffer.byteLength(data)
  if (bytes > MAX_STASH_FILE_BYTES) throw new StashFileTooLargeError(bytes)
  let tempCreated = false
  try {
    await writePrivateFileExclusive(tempPath, data)
    tempCreated = true
    await replaceFile(tempPath, filePath)
    tempCreated = false
  } catch (error) {
    if (tempCreated) await rm(tempPath, { force: true })
    throw error
  }
  // The rename is durable once the directory naming the file is flushed. The
  // directories that name the storage itself were flushed when they were created,
  // so this is the entry the save is actually responsible for.
  try {
    await syncDirectory(directory)
  } catch (error) {
    return { committed: true, phase: 'directory-sync', error }
  }
}
