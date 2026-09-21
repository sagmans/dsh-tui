import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveStashPaths } from '@/stash/paths.ts'
import { createEmptyStashFile, MAX_STASH_ENTRY_BYTES, STASH_SCHEMA_VERSION } from '@/stash/schema.ts'
import { StashCommittedError } from '@/stash/lock.ts'
import {
  loadStashStore,
  StashFileTooLargeError,
  UnsupportedStashSchemaError,
  writeStashFile,
  type StashWriter,
} from '@/stash/store.ts'

const CWD = '/work/me/app'
const scratchDirs: string[] = []

function scratch(): { baseDir: string; file: string } {
  const baseDir = mkdtempSync(join(tmpdir(), 'dsh-stash-store-'))
  scratchDirs.push(baseDir)
  return { baseDir, file: resolveStashPaths(CWD, baseDir).file }
}

afterEach(() => {
  for (const directory of scratchDirs.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function clock(): () => number {
  let tick = 1_000
  return () => (tick += 1)
}

/** Write a raw file at the store's path, as a corrupt or foreign one would be. */
function seed(file: string, contents: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, contents, { mode: 0o600 })
}

describe('StashStore load', () => {
  it('starts empty when the directory has no bank yet', async () => {
    const { baseDir } = scratch()
    const store = await loadStashStore(resolveStashPaths(CWD, baseDir), clock())
    expect(store.entryCount).toBe(0)
    expect(store.entries).toEqual([])
  })

  it('quarantines a file that is not JSON, and says where it went', async () => {
    const { baseDir, file } = scratch()
    seed(file, 'not json at all')
    const store = await loadStashStore(resolveStashPaths(CWD, baseDir), clock())
    const quarantined = store.takeQuarantine()?.path
    expect(quarantined).toBeDefined()
    expect(existsSync(quarantined as string)).toBe(true)
    expect(readFileSync(quarantined as string, 'utf8')).toBe('not json at all')
    expect(existsSync(file)).toBe(false)
    expect(store.entryCount).toBe(0)
  })

  it('quarantines a valid file written for another directory', async () => {
    const { baseDir, file } = scratch()
    seed(
      file,
      JSON.stringify({ version: STASH_SCHEMA_VERSION, cwd: '/somewhere/else', createdAt: 1, updatedAt: 1, entries: [] }),
    )
    const store = await loadStashStore(resolveStashPaths(CWD, baseDir), clock())
    expect(store.takeQuarantine()).toBeDefined()
  })

  it('refuses a newer format without touching it', async () => {
    const { baseDir, file } = scratch()
    seed(file, JSON.stringify({ version: STASH_SCHEMA_VERSION + 1, cwd: '/work/me/app', entries: [] }))
    await expect(loadStashStore(resolveStashPaths(CWD, baseDir), clock())).rejects.toBeInstanceOf(
      UnsupportedStashSchemaError,
    )
    expect(existsSync(file)).toBe(true)
  })
})

describe('StashStore mutations', () => {
  it('keeps the newest entry first and writes it where a reload finds it', async () => {
    const { baseDir } = scratch()
    const paths = resolveStashPaths(CWD, baseDir)
    const store = await loadStashStore(paths, clock())
    await store.add({ id: 'first', text: 'one' })
    await store.add({ id: 'second', text: 'two' })
    expect(store.entries.map(entry => entry.id)).toEqual(['second', 'first'])

    const reloaded = await loadStashStore(paths, clock())
    expect(reloaded.entries.map(entry => entry.text)).toEqual(['two', 'one'])
    expect(JSON.parse(readFileSync(paths.file, 'utf8')).version).toBe(STASH_SCHEMA_VERSION)
  })

  it('refuses a second entry under an id already stored', async () => {
    const { baseDir } = scratch()
    const store = await loadStashStore(resolveStashPaths(CWD, baseDir), clock())
    await store.add({ id: 'fixed', text: 'one' })
    await expect(store.add({ id: 'fixed', text: 'two' })).rejects.toThrow(/duplicate stash id/)
    expect(store.entryCount).toBe(1)
  })

  it('removes by id, by selector, and in one sweep', async () => {
    const { baseDir } = scratch()
    const store = await loadStashStore(resolveStashPaths(CWD, baseDir), clock())
    await store.add({ id: 'a', text: 'one' })
    await store.add({ id: 'b', text: 'two' })
    await store.add({ id: 'c', text: 'three' })

    expect(await store.removeById('b')).toEqual({ entry: expect.objectContaining({ id: 'b' }), index: 1 })
    expect(store.entries.map(entry => entry.id)).toEqual(['c', 'a'])
    expect(await store.removeById('b')).toBeUndefined()

    expect(await store.drop('0')).toEqual({ entry: expect.objectContaining({ id: 'c' }), index: 0 })
    expect(await store.drop('nope')).toBeUndefined()
    expect(await store.clear()).toBe(1)
    expect(store.entryCount).toBe(0)
    expect(await store.clear()).toBe(0)
  })

  it('reloads before a mutation, so a concurrent surface is never overwritten', async () => {
    const { baseDir } = scratch()
    const paths = resolveStashPaths(CWD, baseDir)
    const [one, two] = await Promise.all([loadStashStore(paths, clock()), loadStashStore(paths, clock())])
    await one.add({ id: 'one', text: 'from one' })
    await two.add({ id: 'two', text: 'from two' })
    const reloaded = await loadStashStore(paths, clock())
    expect(reloaded.entries.map(entry => entry.id).sort()).toEqual(['one', 'two'])
  })

  it('reports a committed write separately from a failed one', async () => {
    const { baseDir } = scratch()
    const paths = resolveStashPaths(CWD, baseDir)
    const committed: StashWriter = async () => ({ committed: true, phase: 'directory-sync', error: new Error('fsync') })
    const store = await loadStashStore(paths, clock(), committed)
    const failure = store.add({ id: 'a', text: 'one' })
    await expect(failure).rejects.toBeInstanceOf(StashCommittedError)
    await failure.catch((error: StashCommittedError) => {
      expect(error.result).toEqual({ entry: expect.objectContaining({ id: 'a' }), index: 0 })
    })
    // The entry is in the store's memory, because the write itself landed.
    expect(store.entryCount).toBe(1)
  })

  it('clears only the entries the reader confirmed', async () => {
    const { baseDir } = scratch()
    const paths = resolveStashPaths(CWD, baseDir)
    const store = await loadStashStore(paths, clock())
    await store.add({ id: 'a', text: 'one' })
    await store.add({ id: 'b', text: 'two' })
    const confirmed = store.entries.map(entry => entry.id)

    // Another surface stashes while the confirmation is on screen. Its draft was
    // never named by that confirmation, so clearing must not take it.
    const other = await loadStashStore(paths, clock())
    await other.add({ id: 'later', text: 'added while confirming' })

    expect(await store.clear(confirmed)).toBe(2)
    const reloaded = await loadStashStore(paths, clock())
    expect(reloaded.entries.map(entry => entry.id)).toEqual(['later'])
  })

  it('strips terminal control characters on the way in and on the way out', async () => {
    const { baseDir, file } = scratch()
    const paths = resolveStashPaths(CWD, baseDir)
    const store = await loadStashStore(paths, clock())
    // OSC 52 replaces the clipboard, BEL ends it, and a bidi override reorders
    // what follows without drawing anything a reader could notice.
    await store.add({ id: 'a', text: 'before\u001b]52;c;aGFjaw==\u0007af\u202Eter' })
    expect(store.entries[0]?.text).toBe('before]52;c;aGFjaw==after')
    expect(readFileSync(paths.file, 'utf8')).not.toContain('\u001b')
    expect(readFileSync(paths.file, 'utf8')).not.toContain('\u202E')

    // A hand-edited bank is the other way a sequence can reach the terminal.
    seed(
      file,
      JSON.stringify({
        version: STASH_SCHEMA_VERSION,
        cwd: CWD,
        createdAt: 1,
        updatedAt: 1,
        entries: [{ id: 'hand', text: 'wipe\u001b[2Jthe\u202E screen', createdAt: 1 }],
      }),
    )
    const loaded = await loadStashStore(paths, clock())
    expect(loaded.entries[0]?.text).toBe('wipe[2Jthe screen')
  })
})

describe('StashStore persistence', () => {
  /**
   * The read cap is only a guarantee if a write cannot cross it: a bank that
   * saves successfully and then refuses to load would take the editor's draft
   * with it and hand back nothing.
   */
  it('refuses a write that would land past the read cap, leaving the bank alone', async () => {
    const { baseDir } = scratch()
    const paths = resolveStashPaths(CWD, baseDir)
    const seeded = { ...createEmptyStashFile(CWD, 1), entries: [{ id: 'kept', text: 'one', createdAt: 1 }] }
    await writeStashFile(paths.file, seeded)
    const before = readFileSync(paths.file, 'utf8')

    const oversized = {
      ...createEmptyStashFile(CWD, 1),
      entries: Array.from({ length: 17 }, (_, index) => ({
        id: `big-${index}`,
        text: 'x'.repeat(MAX_STASH_ENTRY_BYTES),
        createdAt: 1,
      })),
    }
    await expect(writeStashFile(paths.file, oversized)).rejects.toBeInstanceOf(StashFileTooLargeError)
    expect(readFileSync(paths.file, 'utf8')).toBe(before)
    const reloaded = await loadStashStore(paths, clock())
    expect(reloaded.entries.map(entry => entry.id)).toEqual(['kept'])
  })

  it('reopens the bytes a committed write left on disk after a sync failure', async () => {
    const { baseDir } = scratch()
    const paths = resolveStashPaths(CWD, baseDir)
    // The real writer with only its last step failing: the rename has happened,
    // so the entry must be readable again rather than merely remembered.
    const failingSync: StashWriter = (filePath, file) =>
      writeStashFile(filePath, file, async () => {
        throw new Error('fsync failed')
      })
    const store = await loadStashStore(paths, clock(), failingSync)
    const failure = store.add({ id: 'landed', text: 'one' })
    await expect(failure).rejects.toBeInstanceOf(StashCommittedError)
    await failure.catch((error: StashCommittedError) => {
      expect(error.failure.phase).toBe('directory-sync')
    })

    const reloaded = await loadStashStore(paths, clock())
    expect(reloaded.entries.map(entry => entry.text)).toEqual(['one'])
  })

  it('keeps the previous bytes when the write never reaches the rename', async () => {
    const { baseDir } = scratch()
    const paths = resolveStashPaths(CWD, baseDir)
    const store = await loadStashStore(paths, clock())
    await store.add({ id: 'kept', text: 'one' })
    const before = readFileSync(paths.file, 'utf8')

    const failing: StashWriter = async () => {
      throw new Error('no space left on device')
    }
    const other = await loadStashStore(paths, clock(), failing)
    await expect(other.add({ id: 'lost', text: 'two' })).rejects.toThrow(/no space left/)
    expect(readFileSync(paths.file, 'utf8')).toBe(before)
    expect((await loadStashStore(paths, clock())).entries.map(entry => entry.id)).toEqual(['kept'])
  })

  it('reads past a temp file a killed writer left behind', async () => {
    const { baseDir } = scratch()
    const paths = resolveStashPaths(CWD, baseDir)
    const store = await loadStashStore(paths, clock())
    await store.add({ id: 'kept', text: 'one' })
    writeFileSync(`${paths.file}.999.1.tmp`, '{"half":', { mode: 0o600 })
    const reloaded = await loadStashStore(paths, clock())
    expect(reloaded.entries.map(entry => entry.id)).toEqual(['kept'])
  })
})
