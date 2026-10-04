// Stash entry + file schema and pure parsing/validation helpers.
//
// Validate persisted drafts before restoring them into the editor. The store
// owns quarantine and I/O failures; these pure helpers only validate structure
// and sanitize text, without making filesystem recovery guarantees.

import { randomUUID } from 'node:crypto'
import { stripControlCharacters } from '../text.ts'

export const STASH_SCHEMA_VERSION = 2

/** Bound the text one newly parked draft adds to the in-memory bank and later editor restore. */
const MAX_STASH_ENTRY_BYTES = 1_048_576

// Ids also serve as command selectors; keep them bounded and free of whitespace and terminal controls.
const ENTRY_ID_MAX_LENGTH = 128
const ENTRY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const NUMERIC_SELECTOR_PATTERN = /^\d+$/u
const INVALID_ENTRY_ID_MESSAGE = 'invalid stash entry id'
const ENTRY_TOO_LARGE_MESSAGE = 'stashed draft is too large'

function isSafeEntryId(value: string): boolean {
  return value.length <= ENTRY_ID_MAX_LENGTH && ENTRY_ID_PATTERN.test(value)
}

export function assertSafeEntryId(value: string): void {
  if (!isSafeEntryId(value)) throw new Error(INVALID_ENTRY_ID_MESSAGE)
}

/** Keep the per-draft admission limit separate from the serialized bank-size cap. */
export function assertSafeStashText(text: string): void {
  if (Buffer.byteLength(text, 'utf8') > MAX_STASH_ENTRY_BYTES) throw new Error(ENTRY_TOO_LARGE_MESSAGE)
}

/** The form of a draft that is safe to hand back to a terminal. */
export function sanitizeStashText(text: string): string {
  return stripControlCharacters(text)
}

export interface StashEntry {
  readonly id: string
  readonly text: string
  readonly createdAt: number
}

export interface StashFile {
  readonly version: typeof STASH_SCHEMA_VERSION
  /**
   * The exact bank owner, either a session id or an absolute directory.
   *
   * The key alone cannot prove ownership: two distinct owners can share a
   * flattened label. Comparing this id on every read prevents one bank from
   * reading or deleting another bank's drafts.
   */
  readonly sessionId: string
  /** Newest first: `entries[0]` is `stash@{0}`. */
  readonly entries: readonly StashEntry[]
}

/** Drafts and lock claims need independently generated identities without a shared counter across surfaces. */
export const createNewId = (): string => randomUUID()

export function createEmptyStashFile(sessionId: string): StashFile {
  return { version: STASH_SCHEMA_VERSION, sessionId, entries: [] }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isValidTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime())
}

function normalizeEntry(raw: unknown): StashEntry | undefined {
  if (!isRecord(raw)) return undefined
  const { id, text, createdAt } = raw
  if (typeof id !== 'string' || !isSafeEntryId(id)) return undefined
  if (typeof text !== 'string') return undefined
  if (!isValidTimestamp(createdAt)) return undefined
  return { id, text: sanitizeStashText(text), createdAt }
}

/**
 * Read one stash file, or nothing when it is not this surface's current format.
 *
 * Strict on purpose: a duplicate id, a malformed entry timestamp, or a foreign
 * session is corruption the store quarantines rather than a shape to repair,
 * because a silently repaired file can resurrect entries the reader thought
 * they dropped — or hand another session's drafts to this one.
 *
 * Keys this format does not name are ignored, which is what lets a bank an
 * older build wrote keep loading: it persisted file-level timestamps nothing
 * ever read, and refusing them would quarantine drafts that are still valid.
 */
export function parseStashFile(raw: unknown): StashFile | undefined {
  if (!isRecord(raw) || raw.version !== STASH_SCHEMA_VERSION) return undefined
  if (typeof raw.sessionId !== 'string') return undefined
  if (!Array.isArray(raw.entries)) return undefined
  const entries: StashEntry[] = []
  const ids = new Set<string>()
  for (const rawEntry of raw.entries) {
    const entry = normalizeEntry(rawEntry)
    if (entry === undefined || ids.has(entry.id)) return undefined
    ids.add(entry.id)
    entries.push(entry)
  }
  return { version: STASH_SCHEMA_VERSION, sessionId: raw.sessionId, entries }
}

/** Keep stable identity for later removal and position for user-facing notices. */
export interface ResolvedEntry {
  readonly entry: StashEntry
  readonly index: number
}

/**
 * Resolve a selector against newest-first entries.
 *
 * Index 0 is the newest, mirroring git's index-0-is-tip convention. A selector
 * is an entry id, a numeric index string, or empty for the most recent entry.
 */
export function resolveBySelector(
  entries: readonly StashEntry[],
  selector: string | undefined,
): ResolvedEntry | undefined {
  if (entries.length === 0) return undefined
  const trimmed = selector?.trim()
  if (trimmed === undefined || trimmed === '') {
    const entry = entries[0]
    return entry === undefined ? undefined : { entry, index: 0 }
  }
  // Numeric ids are valid too; prefer exact identity so position changes cannot retarget an id selector.
  const index = entries.findIndex(entry => entry.id === trimmed)
  if (index >= 0) return { entry: entries[index] as StashEntry, index }
  if (!NUMERIC_SELECTOR_PATTERN.test(trimmed)) return undefined
  const numeric = Number(trimmed)
  if (!Number.isSafeInteger(numeric) || numeric >= entries.length) return undefined
  const entry = entries[numeric]
  return entry === undefined ? undefined : { entry, index: numeric }
}
