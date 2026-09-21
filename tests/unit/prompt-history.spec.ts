import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_ENTRIES,
  HISTORY_FILE_NAME,
  HISTORY_SCHEMA_VERSION,
  createPromptHistory,
  parseHistoryFile,
  resolveDshHome,
  upsertEntry,
  type PromptEntry,
} from '@/agent/prompt-history.ts'

const AT = (seconds: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString()

const entry = (text: string, seconds: number, useCount = 1): PromptEntry => ({
  text,
  updatedAt: AT(seconds),
  useCount,
})

async function scratchHome(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'dsh-tui-history-'))
}

describe('resolveDshHome', () => {
  it('takes a non-blank DSH_HOME', () => {
    expect(resolveDshHome({ DSH_HOME: '/tmp/custom' })).toBe('/tmp/custom')
  })

  it('falls back to ~/.dsh for an absent or blank DSH_HOME', () => {
    const fallback = join(homedir(), '.dsh')
    expect(resolveDshHome({})).toBe(fallback)
    expect(resolveDshHome({ DSH_HOME: '   ' })).toBe(fallback)
  })

  it('expands a tilde prefix rather than resolving it against the cwd', () => {
    expect(resolveDshHome({ DSH_HOME: '~/harness' })).toBe(join(homedir(), 'harness'))
  })
})

describe('upsertEntry', () => {
  it('moves an exact duplicate to the front and counts the use', () => {
    const next = upsertEntry([entry('older', 1), entry('same', 2)], 'same', AT(3), 10)
    expect(next.map(item => item.text)).toEqual(['same', 'older'])
    expect(next[0]).toMatchObject({ useCount: 2, updatedAt: AT(3) })
  })

  it('adds a new prompt at the front', () => {
    const next = upsertEntry([entry('older', 1)], 'newer', AT(2), 10)
    expect(next.map(item => item.text)).toEqual(['newer', 'older'])
  })

  it('caps the list at maxEntries', () => {
    const next = upsertEntry([entry('a', 1), entry('b', 2)], 'c', AT(3), 2)
    expect(next.map(item => item.text)).toEqual(['c', 'a'])
  })

  it('never moves a timestamp backwards', () => {
    const next = upsertEntry([entry('same', 5)], 'same', AT(1), 10)
    expect(next[0]?.updatedAt).toBe(AT(5))
  })
})

describe('parseHistoryFile', () => {
  it('reads a well-formed file', () => {
    const parsed = parseHistoryFile(JSON.stringify({
      version: HISTORY_SCHEMA_VERSION,
      updatedAt: AT(1),
      entries: [entry('hello', 1)],
    }))
    expect(parsed).toEqual({
      kind: 'ready',
      file: { version: HISTORY_SCHEMA_VERSION, updatedAt: AT(1), entries: [entry('hello', 1)] },
    })
  })

  it('spells out control characters so a stored prompt cannot drive the terminal', () => {
    const raw = JSON.stringify({
      version: HISTORY_SCHEMA_VERSION,
      updatedAt: AT(1),
      entries: [entry('a\u001b[2Jb', 1)],
    })
    const parsed = parseHistoryFile(raw)
    expect(parsed.kind).toBe('ready')
    if (parsed.kind !== 'ready') return
    expect(parsed.file.entries[0]?.text).toBe('a\\x1B[2Jb')
  })

  it('accepts a file with no entries', () => {
    const parsed = parseHistoryFile(JSON.stringify({
      version: HISTORY_SCHEMA_VERSION,
      updatedAt: AT(1),
      entries: [],
    }))
    expect(parsed.kind).toBe('ready')
  })

  it('blocks a corrupt file instead of guessing', () => {
    expect(parseHistoryFile('{ not json')).toEqual({ kind: 'blocked', reason: 'corrupt_history' })
  })

  it('blocks a newer schema so it is never overwritten', () => {
    const raw = JSON.stringify({ version: HISTORY_SCHEMA_VERSION + 1, updatedAt: AT(1), entries: [] })
    expect(parseHistoryFile(raw)).toEqual({ kind: 'blocked', reason: 'unsupported_schema' })
  })

  it('blocks an entry that is missing a field', () => {
    const raw = JSON.stringify({
      version: HISTORY_SCHEMA_VERSION,
      updatedAt: AT(1),
      entries: [{ text: 'hello' }],
    })
    expect(parseHistoryFile(raw)).toEqual({ kind: 'blocked', reason: 'corrupt_history' })
  })
})

describe('createPromptHistory', () => {
  it('records a prompt to a private file and reloads it', async () => {
    const home = await scratchHome()
    const history = createPromptHistory({ home, cap: () => DEFAULT_MAX_ENTRIES, now: () => new Date(AT(1)) })
    history.record('first prompt')
    await history.flush()

    const path = history.path()
    expect(path).toBe(join(home, HISTORY_FILE_NAME))
    expect((await stat(path)).mode & 0o777).toBe(0o600)

    const reloaded = createPromptHistory({ home, cap: () => DEFAULT_MAX_ENTRIES })
    await reloaded.flush()
    expect(reloaded.entries().map(item => item.text)).toEqual(['first prompt'])
  })

  it('serializes a record that races the initial load', async () => {
    const home = await scratchHome()
    await writeFile(historyPath(home), JSON.stringify({
      version: HISTORY_SCHEMA_VERSION,
      updatedAt: AT(1),
      entries: [entry('from disk', 1)],
    }))
    const history = createPromptHistory({ home, cap: () => DEFAULT_MAX_ENTRIES, now: () => new Date(AT(2)) })
    history.record('typed immediately')
    await history.flush()
    expect(history.entries().map(item => item.text)).toEqual(['typed immediately', 'from disk'])
  })

  it('keeps a prompt another store wrote after it loaded', async () => {
    const home = await scratchHome()
    const first = createPromptHistory({ home, cap: () => DEFAULT_MAX_ENTRIES, now: () => new Date(AT(1)) })
    const second = createPromptHistory({ home, cap: () => DEFAULT_MAX_ENTRIES, now: () => new Date(AT(2)) })
    await Promise.all([first.flush(), second.flush()])
    first.record('from the first session')
    await first.flush()
    second.record('from the second session')
    await second.flush()
    const read = async (): Promise<string[]> =>
      (JSON.parse(await readFile(historyPath(home), 'utf8')) as { entries: PromptEntry[] }).entries.map(item => item.text)
    expect(await read()).toEqual(['from the second session', 'from the first session'])

    first.record('from the first session')
    await first.flush()
    expect(await read()).toEqual(['from the first session', 'from the second session'])
  })

  it('refuses a newer schema that appeared after startup', async () => {
    const home = await scratchHome()
    const history = createPromptHistory({ home, cap: () => DEFAULT_MAX_ENTRIES })
    await history.flush()
    const newer = JSON.stringify({ version: HISTORY_SCHEMA_VERSION + 1, updatedAt: AT(1), entries: [] })
    await writeFile(historyPath(home), newer)
    history.record('must not clobber')
    await history.flush()
    expect(history.blockedReason()).toBe('unsupported_schema')
    expect(await readFile(historyPath(home), 'utf8')).toBe(newer)
  })

  it('keeps the entries when a clear cannot be written', async () => {
    const home = await scratchHome()
    const history = createPromptHistory({ home, cap: () => DEFAULT_MAX_ENTRIES, now: () => new Date(AT(1)) })
    history.record('keep me')
    await history.flush()
    await chmod(home, 0o500)
    try {
      await expect(history.clear()).rejects.toThrow()
      expect(history.entries().map(item => item.text)).toEqual(['keep me'])
      expect(JSON.parse(await readFile(history.path(), 'utf8'))).toMatchObject({ entries: [{ text: 'keep me' }] })
    } finally {
      await chmod(home, 0o700)
    }
  })

  it('clears the file and reports how many entries went', async () => {
    const home = await scratchHome()
    const history = createPromptHistory({ home, cap: () => DEFAULT_MAX_ENTRIES, now: () => new Date(AT(1)) })
    history.record('one')
    history.record('two')
    expect(await history.clear()).toBe(2)
    expect(history.entries()).toEqual([])
    expect(JSON.parse(await readFile(history.path(), 'utf8'))).toMatchObject({ entries: [] })
  })

  it('refuses to overwrite a corrupt file and says why once', async () => {
    const home = await scratchHome()
    await writeFile(historyPath(home), '{ not json')
    const warnings: string[] = []
    const history = createPromptHistory({ home, cap: () => DEFAULT_MAX_ENTRIES, warn: message => warnings.push(message) })
    history.record('must not clobber')
    await history.flush()
    expect(history.blockedReason()).toBe('corrupt_history')
    expect(history.entries()).toEqual([])
    expect(await readFile(history.path(), 'utf8')).toBe('{ not json')
    expect(warnings).toHaveLength(1)
  })

  it('trims the file to the configured cap', async () => {
    const home = await scratchHome()
    let second = 0
    const history = createPromptHistory({ home, cap: () => 2, now: () => new Date(AT(++second)) })
    history.record('a')
    history.record('b')
    history.record('c')
    await history.flush()
    expect(history.entries().map(item => item.text)).toEqual(['c', 'b'])
  })

  it('never records a control sequence a brush could draw or insert', async () => {
    const home = await scratchHome()
    const history = createPromptHistory({ home, cap: () => DEFAULT_MAX_ENTRIES, now: () => new Date(AT(1)) })
    history.record('a\u001b[2Jb')
    await history.flush()
    expect(history.entries()[0]?.text).toBe('a\\x1B[2Jb')
    expect(JSON.parse(await readFile(history.path(), 'utf8')).entries[0].text).toBe('a\\x1B[2Jb')
  })

  it('ignores a blank prompt', async () => {
    const home = await scratchHome()
    const history = createPromptHistory({ home, cap: () => DEFAULT_MAX_ENTRIES })
    history.record('   \n  ')
    await history.flush()
    expect(history.entries()).toEqual([])
  })
})

function historyPath(home: string): string {
  return join(home, HISTORY_FILE_NAME)
}
