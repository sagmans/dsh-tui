import { describe, expect, it } from 'vitest'
import {
  assertSafeEntryId,
  assertSafeStashText,
  createEmptyStashFile,
  createNewId,
  isSafeEntryId,
  MAX_STASH_ENTRY_BYTES,
  normalizeEntry,
  parseStashFile,
  resolveBySelector,
  STASH_SCHEMA_VERSION,
  type StashEntry,
} from '@/stash/schema.ts'

const entry = (id: string, text = id, createdAt = 1_000): StashEntry => ({ id, text, createdAt })

const file = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: STASH_SCHEMA_VERSION,
  cwd: 'v1--work',
  createdAt: 1,
  updatedAt: 2,
  entries: [entry('a')],
  ...overrides,
})

describe('stash entry ids', () => {
  it('accepts the shape a generated id has', () => {
    expect(isSafeEntryId(createNewId())).toBe(true)
    expect(isSafeEntryId('a.b_c-1')).toBe(true)
    expect(() => assertSafeEntryId('a/b')).toThrow(/invalid stash entry id/)
  })

  it('refuses an id that could escape a filename or a list', () => {
    for (const bad of ['', '.hidden', '-lead', 'a/b', 'a b', 'a\n', 'x'.repeat(129)]) {
      expect(isSafeEntryId(bad), bad).toBe(false)
    }
  })
})

describe('createEmptyStashFile', () => {
  it('starts a fresh, versioned bank for one directory', () => {
    expect(createEmptyStashFile('v1--work', 42)).toEqual({
      version: STASH_SCHEMA_VERSION,
      cwd: 'v1--work',
      createdAt: 42,
      updatedAt: 42,
      entries: [],
    })
  })
})

describe('normalizeEntry', () => {
  it('keeps a well-formed entry and drops a malformed one', () => {
    expect(normalizeEntry(entry('a'))).toEqual(entry('a'))
    expect(normalizeEntry({ id: 'a', text: 'x' })).toBeUndefined()
    expect(normalizeEntry({ id: '../a', text: 'x', createdAt: 1 })).toBeUndefined()
    expect(normalizeEntry({ id: 'a', text: 3, createdAt: 1 })).toBeUndefined()
    expect(normalizeEntry({ id: 'a', text: 'x', createdAt: Number.NaN })).toBeUndefined()
    expect(normalizeEntry('a')).toBeUndefined()
    expect(normalizeEntry(null)).toBeUndefined()
  })
})

describe('parseStashFile', () => {
  it('accepts a file this build wrote', () => {
    expect(parseStashFile(file())?.entries).toEqual([entry('a')])
  })

  it('refuses a version this build does not know, without repairing it', () => {
    expect(parseStashFile(file({ version: STASH_SCHEMA_VERSION + 1 }))).toBeUndefined()
    expect(parseStashFile(file({ version: '1' }))).toBeUndefined()
  })

  it('refuses a file whose entries could be ambiguous or unusable', () => {
    expect(parseStashFile(file({ cwd: 3 }))).toBeUndefined()
    expect(parseStashFile(file({ createdAt: 'yesterday' }))).toBeUndefined()
    expect(parseStashFile(file({ updatedAt: undefined }))).toBeUndefined()
    expect(parseStashFile(file({ entries: 'none' }))).toBeUndefined()
    expect(parseStashFile(file({ entries: [entry('a'), entry('a')] }))).toBeUndefined()
    expect(parseStashFile(file({ entries: [{ id: 'a', text: 'x' }] }))).toBeUndefined()
    expect(parseStashFile([])).toBeUndefined()
    expect(parseStashFile(undefined)).toBeUndefined()
  })
})

describe('resolveBySelector', () => {
  const entries = [entry('newest'), entry('middle'), entry('oldest')]

  it('takes the newest for an empty selector, because index 0 is the tip', () => {
    expect(resolveBySelector(entries, undefined)).toEqual({ entry: entries[0], index: 0 })
    expect(resolveBySelector(entries, '  ')).toEqual({ entry: entries[0], index: 0 })
  })

  it('resolves a displayed index and an exact id', () => {
    expect(resolveBySelector(entries, '2')).toEqual({ entry: entries[2], index: 2 })
    expect(resolveBySelector(entries, 'middle')).toEqual({ entry: entries[1], index: 1 })
  })

  it('refuses an index off the end and a selector that names nothing', () => {
    expect(resolveBySelector(entries, '3')).toBeUndefined()
    expect(resolveBySelector(entries, '-1')).toBeUndefined()
    expect(resolveBySelector(entries, 'nope')).toBeUndefined()
    expect(resolveBySelector([], '0')).toBeUndefined()
    expect(resolveBySelector([], undefined)).toBeUndefined()
  })
})

describe('assertSafeStashText', () => {
  it('accepts a large draft and refuses one past the cap', () => {
    expect(() => assertSafeStashText('x'.repeat(MAX_STASH_ENTRY_BYTES))).not.toThrow()
    expect(() => assertSafeStashText('x'.repeat(MAX_STASH_ENTRY_BYTES + 1))).toThrow(/too large/)
  })
})
