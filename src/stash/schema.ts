// Stash entry + file schema and pure parsing/validation helpers.
//
// Every disk format is validated on read, so a corrupt or hand-edited stash file
// can never crash the editor: an unparseable file is treated as empty and
// quarantined by the store. Keeping this module free of fs dependencies makes
// the schema fully unit-testable.

import { randomUUID } from 'node:crypto'

export const STASH_SCHEMA_VERSION = 1

/** A stash longer than this is refused rather than stored. */
export const MAX_STASH_ENTRY_BYTES = 1_048_576

const ENTRY_ID_MAX_LENGTH = 128
const ENTRY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const NUMERIC_SELECTOR_PATTERN = /^\d+$/u
const INVALID_ENTRY_ID_MESSAGE = 'invalid stash entry id'
const ENTRY_TOO_LARGE_MESSAGE = 'stashed draft is too large'

export function isSafeEntryId(value: string): boolean {
  return value.length <= ENTRY_ID_MAX_LENGTH && ENTRY_ID_PATTERN.test(value)
}

export function assertSafeEntryId(value: string): void {
  if (!isSafeEntryId(value)) throw new Error(INVALID_ENTRY_ID_MESSAGE)
}

/** Refuse one draft that no amount of storage capacity could justify holding. */
export function assertSafeStashText(text: string): void {
  if (Buffer.byteLength(text, 'utf8') > MAX_STASH_ENTRY_BYTES) throw new Error(ENTRY_TOO_LARGE_MESSAGE)
}

export interface StashEntry {
  readonly id: string
  readonly text: string
  readonly createdAt: number
}

export interface StashFile {
  readonly version: typeof STASH_SCHEMA_VERSION
  /** The flattened cwd key this file belongs to, so a mis-keyed file is refused. */
  readonly cwd: string
  readonly createdAt: number
  readonly updatedAt: number
  /** Newest first: `entries[0]` is `stash@{0}`. */
  readonly entries: readonly StashEntry[]
}

export type Clock = () => number

export const createNewId = (): string => randomUUID()

export function createEmptyStashFile(cwd: string, now: number): StashFile {
  return { version: STASH_SCHEMA_VERSION, cwd, createdAt: now, updatedAt: now, entries: [] }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isValidTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime())
}

export function normalizeEntry(raw: unknown): StashEntry | undefined {
  if (!isRecord(raw)) return undefined
  const { id, text, createdAt } = raw
  if (typeof id !== 'string' || !isSafeEntryId(id)) return undefined
  if (typeof text !== 'string') return undefined
  if (!isValidTimestamp(createdAt)) return undefined
  return { id, text, createdAt }
}

/**
 * Read one stash file, or nothing when it is not this surface's current format.
 *
 * Strict on purpose: a duplicate id, a missing timestamp, or a foreign cwd key
 * is corruption the store quarantines rather than a shape to repair, because a
 * silently repaired file can resurrect entries the reader thought they dropped.
 */
export function parseStashFile(raw: unknown): StashFile | undefined {
  if (!isRecord(raw) || raw.version !== STASH_SCHEMA_VERSION) return undefined
  if (typeof raw.cwd !== 'string') return undefined
  if (!isValidTimestamp(raw.createdAt) || !isValidTimestamp(raw.updatedAt)) return undefined
  if (!Array.isArray(raw.entries)) return undefined
  const entries: StashEntry[] = []
  const ids = new Set<string>()
  for (const rawEntry of raw.entries) {
    const entry = normalizeEntry(rawEntry)
    if (entry === undefined || ids.has(entry.id)) return undefined
    ids.add(entry.id)
    entries.push(entry)
  }
  return { version: STASH_SCHEMA_VERSION, cwd: raw.cwd, createdAt: raw.createdAt, updatedAt: raw.updatedAt, entries }
}

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
  const index = entries.findIndex(entry => entry.id === trimmed)
  if (index >= 0) return { entry: entries[index] as StashEntry, index }
  if (!NUMERIC_SELECTOR_PATTERN.test(trimmed)) return undefined
  const numeric = Number(trimmed)
  if (!Number.isSafeInteger(numeric) || numeric >= entries.length) return undefined
  const entry = entries[numeric]
  return entry === undefined ? undefined : { entry, index: numeric }
}
