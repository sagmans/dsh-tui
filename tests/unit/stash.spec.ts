import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PromptStash, type StashHost } from '@/stash.ts'
import { resolveStashPaths } from '@/stash/paths.ts'
import type { ResolvedEntry } from '@/stash/schema.ts'
import { StashCommittedError } from '@/stash/lock.ts'
import { loadStashStore, writeStashFile, type StashWriter } from '@/stash/store.ts'

const CWD = '/work/me/app'
const scratchDirs: string[] = []

function scratchBase(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-stash-ops-'))
  scratchDirs.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of scratchDirs.splice(0)) rmSync(directory, { recursive: true, force: true })
})

class FakeHost implements StashHost {
  editorText = ''
  readonly notices: string[] = []
  renders = 0
  confirmations = 0
  confirmResult = false
  editorAvailable = true
  picked: readonly ResolvedEntry[] = []
  pickChooser: (entries: readonly ResolvedEntry[]) => string | undefined = () => undefined

  getEditorText(): string {
    return this.editorText
  }

  setEditorText(text: string): void {
    this.editorText = text
  }

  editorIsAvailable(): boolean {
    return this.editorAvailable
  }

  notice(message: string): void {
    this.notices.push(message)
  }

  async pick(entries: readonly ResolvedEntry[]): Promise<string | undefined> {
    this.picked = entries
    return this.pickChooser(entries)
  }

  async confirm(): Promise<boolean> {
    this.confirmations += 1
    if (this.onConfirm !== undefined) await this.onConfirm()
    return this.confirmResult
  }

  onConfirm: (() => Promise<void>) | undefined

  render(): void {
    this.renders += 1
  }

  last(): string | undefined {
    return this.notices.at(-1)
  }
}

function bank(host: FakeHost, overrides: { baseDir?: string; write?: StashWriter } = {}): PromptStash {
  return new PromptStash(host, {
    cwd: CWD,
    baseDir: overrides.baseDir ?? scratchBase(),
    ...(overrides.write === undefined ? {} : { write: overrides.write }),
  })
}

describe('stashing the editor draft', () => {
  it('stores the draft and clears it only after the write lands', async () => {
    const host = new FakeHost()
    const stash = bank(host)
    await stash.open()
    host.editorText = 'a draft I do not want to send yet'
    await stash.stashEditor()
    expect(host.editorText).toBe('')
    expect(host.last()).toBe('Stashed [0]')
    expect(stash.entryCount).toBe(1)
    expect(host.renders).toBeGreaterThan(0)
  })

  it('says so rather than writing an empty draft', async () => {
    const host = new FakeHost()
    const stash = bank(host)
    host.editorText = '   \n  '
    await stash.stashEditor()
    expect(host.last()).toBe('nothing to stash')
    expect(stash.entryCount).toBe(0)
  })

  it('stores a draft given on the command line and leaves the bar clear', async () => {
    const host = new FakeHost()
    const baseDir = scratchBase()
    const stash = bank(host, { baseDir })
    await stash.stashEditor('park this instead')
    expect(host.editorText).toBe('')

    const reloaded = await loadStashStore(resolveStashPaths(CWD, baseDir))
    expect(reloaded.entries.map(entry => entry.text)).toEqual(['park this instead'])
  })

  /**
   * The command line is gone by the time the command runs, so the argument is
   * the only copy of the draft there is: a refused write has to put it back in
   * the bar rather than drop it.
   */
  it('keeps a typed draft in the bar when the write is refused', async () => {
    const host = new FakeHost()
    const stash = bank(host, {
      write: async () => {
        throw new Error('disk is full')
      },
    })
    await stash.stashEditor('the only copy')
    expect(host.editorText).toBe('the only copy')
    expect(host.last()).toContain('disk is full')
    expect(stash.entryCount).toBe(0)
  })

  /**
   * The chord arrives as this same command with no argument, and it is pressed
   * while the reader is looking at the draft they want parked.
   */
  it('parks the bar when the command names no draft', async () => {
    const host = new FakeHost()
    host.editorText = 'still writing this'
    const stash = bank(host)
    await stash.stashEditor('')
    expect(host.last()).toBe('Stashed [0]')
    expect(host.editorText).toBe('')
    expect(stash.entryCount).toBe(1)
  })

  /**
   * The bank is opened before the draft is written, so a storage path that
   * cannot even be opened is a failure the reader still has to be able to retry
   * from the bar.
   */
  it('keeps a typed draft in the bar when the bank cannot be opened at all', async () => {
    const host = new FakeHost()
    const baseDir = scratchBase()
    const blocked = join(baseDir, 'blocked')
    writeFileSync(blocked, 'not a directory')
    const stash = bank(host, { baseDir: blocked })
    await stash.stashEditor('the only copy')
    expect(host.editorText).toBe('the only copy')
    expect(host.last()).toContain('stash failed')
  })

  it('says nothing to stash when neither the command nor the bar holds one', async () => {
    const host = new FakeHost()
    const stash = bank(host)
    await stash.stashEditor('   ')
    expect(host.last()).toBe('nothing to stash')
    expect(stash.entryCount).toBe(0)
  })

  /**
   * The draft is on disk, so reporting a failure would invite a retry that
   * stashes the same draft twice and leave the bar holding a copy of it.
   */
  it('reports a committed stash as success and hands the bar back empty', async () => {
    const host = new FakeHost()
    const baseDir = scratchBase()
    const shaky: StashWriter = async (file, contents) => {
      await writeStashFile(file, contents)
      return { committed: true, phase: 'directory-sync', error: new Error('fsync failed') }
    }
    const stash = bank(host, { baseDir, write: shaky })
    await stash.stashEditor('parked')
    expect(host.last()).toBe('Stashed [0], but the directory-sync step failed')
    expect(host.editorText).toBe('')

    const reloaded = await loadStashStore(resolveStashPaths(CWD, baseDir))
    expect(reloaded.entries.map(entry => entry.text)).toEqual(['parked'])
  })

  it('names both failed steps when the lock could not be released either', async () => {
    const host = new FakeHost()
    const both: StashWriter = async () => {
      throw new StashCommittedError(
        { entry: { id: 'a', text: 'parked', createdAt: 1 }, index: 0 },
        { phase: 'directory-sync', error: new Error('fsync failed') },
        { phase: 'lock-release', error: new Error('busy') },
      )
    }
    const stash = bank(host, { write: both })
    await stash.stashEditor('parked')
    expect(host.last()).toBe('Stashed [0], but the directory-sync and lock-release steps failed')
    expect(host.editorText).toBe('')
  })

  it('never writes a draft into a bar that is answering a question', async () => {
    const host = new FakeHost()
    const stash = bank(host)
    host.editorAvailable = false
    await stash.stashEditor('parked')
    expect(host.editorText).toBe('')
    expect(host.last()).toContain('answering a question')
    expect(stash.entryCount).toBe(0)
  })

  /**
   * The write awaits the disk, and a question can take the bar while it does. The
   * answer standing in the bar at that moment is not the draft that was parked,
   * so it must not be cleared by the stash finishing.
   */
  it('does not clear a bar a question borrowed during the write', async () => {
    const host = new FakeHost()
    const baseDir = scratchBase()
    const borrowing: StashWriter = async (file, contents) => {
      host.editorAvailable = false
      host.editorText = 'an answer typed into the question'
      return await writeStashFile(file, contents)
    }
    const stash = bank(host, { baseDir, write: borrowing })
    await stash.stashEditor('parked')
    expect(host.editorText).toBe('an answer typed into the question')
    expect(host.last()).toBe('Stashed [0]')
  })
})

describe('applying a draft', () => {
  it('fills an empty editor and keeps the entry', async () => {
    const host = new FakeHost()
    const stash = bank(host)
    await stash.stashEditor('one')
    await stash.stashEditor('two')
    await stash.apply(undefined)
    expect(host.editorText).toBe('two')
    expect(host.last()).toBe('Applied [0]')
    expect(stash.entryCount).toBe(2)
  })

  it('resolves an older draft by its displayed index', async () => {
    const host = new FakeHost()
    const stash = bank(host)
    await stash.stashEditor('one')
    await stash.stashEditor('two')
    await stash.apply('1')
    expect(host.editorText).toBe('one')
    expect(host.last()).toBe('Applied [1]')
  })

  it('refuses to overwrite a draft already in the editor', async () => {
    const host = new FakeHost()
    const stash = bank(host)
    await stash.stashEditor('parked')
    host.editorText = 'mine'
    await stash.apply(undefined)
    expect(host.editorText).toBe('mine')
    expect(host.last()).toBe('clear or stash the current draft before applying or popping')
    expect(stash.entryCount).toBe(1)
  })

  it('names a selector that matches nothing', async () => {
    const host = new FakeHost()
    const stash = bank(host)
    await stash.stashEditor('parked')
    await stash.apply('ghost')
    expect(host.last()).toBe('no stash matching "ghost"')
  })

  it('says the bank is empty rather than matching an empty selector', async () => {
    const host = new FakeHost()
    const stash = bank(host)
    await stash.apply(undefined)
    expect(host.last()).toBe('no stashed drafts')
  })
})

describe('popping a draft', () => {
  it('fills the editor and removes exactly the entry it took', async () => {
    const host = new FakeHost()
    const baseDir = scratchBase()
    const stash = bank(host, { baseDir })
    await stash.stashEditor('one')
    await stash.stashEditor('two')
    await stash.pop('1')
    expect(host.editorText).toBe('one')
    expect(host.last()).toBe('Popped [1]')
    expect(stash.entryCount).toBe(1)

    const reloaded = await loadStashStore(resolveStashPaths(CWD, baseDir))
    expect(reloaded.entries.map(entry => entry.text)).toEqual(['two'])
  })

  it('resolves the newest from disk, not from a snapshot another surface left stale', async () => {
    const baseDir = scratchBase()
    const mine = new FakeHost()
    const first = bank(mine, { baseDir })
    await first.open()
    const other = new FakeHost()
    await bank(other, { baseDir }).stashEditor('added elsewhere')
    await first.pop(undefined)
    expect(mine.editorText).toBe('added elsewhere')
    expect(first.entryCount).toBe(0)
  })

  it('refuses to overwrite a draft already in the editor', async () => {
    const host = new FakeHost()
    const stash = bank(host)
    await stash.stashEditor('parked')
    host.editorText = 'mine'
    await stash.pop(undefined)
    expect(host.editorText).toBe('mine')
    expect(stash.entryCount).toBe(1)
  })

  /**
   * A question borrows the bar and empties it, so an empty editor is not proof
   * that the bar is the reader's. Filling it here would type the draft into an
   * answer and then delete the only other copy.
   */
  it('refuses to pop into a bar that is answering a question', async () => {
    const host = new FakeHost()
    const stash = bank(host)
    await stash.stashEditor('parked')
    host.editorAvailable = false
    await stash.pop(undefined)
    expect(host.last()).toContain('answering a question')
    expect(host.editorText).toBe('')
    expect(stash.entryCount).toBe(1)
  })

  it('keeps the entry when the removal write fails, so no draft is lost', async () => {
    const host = new FakeHost()
    const baseDir = scratchBase()
    let writes = 0
    const shaky: StashWriter = async (file, contents) => {
      writes += 1
      if (writes > 1) throw new Error('disk full')
      return await writeStashFile(file, contents)
    }
    const stash = bank(host, { baseDir, write: shaky })
    await stash.stashEditor('one')
    await stash.pop(undefined)
    // The editor has the draft and the bank still holds it, which is the safe
    // side of a crash between the two.
    expect(host.editorText).toBe('one')
    expect(host.last()).toMatch(/removing the entry failed: disk full/)
    const reloaded = await loadStashStore(resolveStashPaths(CWD, baseDir))
    expect(reloaded.entryCount).toBe(1)
  })

  it('reports a committed removal as popped with a warning rather than a loss', async () => {
    const host = new FakeHost()
    const baseDir = scratchBase()
    await (await loadStashStore(resolveStashPaths(CWD, baseDir))).add({ id: 'a', text: 'one' })
    const committed: StashWriter = async () => ({ committed: true, phase: 'lock-release', error: new Error('busy') })
    const stash = bank(host, { baseDir, write: committed })
    await stash.pop(undefined)
    expect(host.editorText).toBe('one')
    expect(host.last()).toBe('Popped [0], but the lock-release step failed')
  })
})

describe('dropping drafts', () => {
  it('removes the newest without using it or touching the editor', async () => {
    const host = new FakeHost()
    const stash = bank(host)
    await stash.stashEditor('one')
    host.editorText = 'mine'
    await stash.drop(undefined)
    expect(host.editorText).toBe('mine')
    expect(host.last()).toBe('Dropped [0]')
    expect(stash.entryCount).toBe(0)
  })

  it('names a selector that matches nothing', async () => {
    const host = new FakeHost()
    const stash = bank(host)
    await stash.stashEditor('one')
    await stash.drop('ghost')
    expect(host.last()).toBe('no stash matching "ghost"')
    expect(stash.entryCount).toBe(1)
  })
})

describe('clearing the bank', () => {
  it('keeps every draft when the reader does not confirm', async () => {
    const host = new FakeHost()
    const stash = bank(host)
    await stash.stashEditor('one')
    await stash.stashEditor('two')
    host.confirmResult = false
    await stash.clear()
    expect(host.confirmations).toBe(1)
    expect(stash.entryCount).toBe(2)
  })

  it('removes every draft once the reader confirms', async () => {
    const host = new FakeHost()
    const stash = bank(host)
    await stash.stashEditor('one')
    await stash.stashEditor('two')
    host.confirmResult = true
    await stash.clear()
    expect(host.last()).toBe('Cleared 2 drafts')
    expect(stash.entryCount).toBe(0)
  })

  it('never asks to confirm an empty bank', async () => {
    const host = new FakeHost()
    const stash = bank(host)
    await stash.clear()
    expect(host.confirmations).toBe(0)
    expect(host.last()).toBe('no stashed drafts')
  })

  /**
   * The dialog says how many drafts it is about to delete, so a draft stashed
   * while it was on screen was never part of what the reader agreed to.
   */
  it('leaves a draft that arrived while the confirmation was on screen', async () => {
    const host = new FakeHost()
    const baseDir = scratchBase()
    const stash = bank(host, { baseDir })
    await stash.stashEditor('one')
    await stash.stashEditor('two')
    host.confirmResult = true
    host.onConfirm = async () => {
      await bank(new FakeHost(), { baseDir }).stashEditor('added while confirming')
    }
    await stash.clear()
    expect(host.last()).toBe('Cleared 2 drafts')

    const reloaded = await loadStashStore(resolveStashPaths(CWD, baseDir))
    expect(reloaded.entries.map(entry => entry.text)).toEqual(['added while confirming'])
  })
})

describe('listing drafts', () => {
  it('pops the entry the reader took', async () => {
    const host = new FakeHost()
    const baseDir = scratchBase()
    const stash = bank(host, { baseDir })
    await stash.stashEditor('one')
    await stash.stashEditor('two')
    host.pickChooser = entries => entries[1]?.entry.id
    await stash.list('~/app')
    expect(host.editorText).toBe('one')
    expect(stash.entryCount).toBe(1)
    const reloaded = await loadStashStore(resolveStashPaths(CWD, baseDir))
    expect(reloaded.entries.map(entry => entry.text)).toEqual(['two'])
  })

  it('shows each row the index the same draft answers to on the command line', async () => {
    const host = new FakeHost()
    const stash = bank(host)
    await stash.stashEditor('one')
    await stash.stashEditor('two')
    await stash.list('~/app')
    expect(host.picked.map(row => row.index)).toEqual([0, 1])
    expect(host.picked.map(row => row.entry.text)).toEqual(['two', 'one'])
  })

  it('does nothing when the reader leaves the list', async () => {
    const host = new FakeHost()
    const stash = bank(host)
    await stash.stashEditor('one')
    await stash.list('~/app')
    expect(host.editorText).toBe('')
    expect(stash.entryCount).toBe(1)
  })

  it('says the bank is empty instead of opening an empty list', async () => {
    const host = new FakeHost()
    const stash = bank(host)
    await stash.list('~/app')
    expect(host.last()).toBe('no stashed drafts')
  })
})

describe('open', () => {
  it('reports where a corrupt bank was quarantined', async () => {
    const host = new FakeHost()
    const baseDir = scratchBase()
    writeFileSync(resolveStashPaths(CWD, baseDir).file, 'not json')
    const stash = bank(host, { baseDir })
    await stash.open()
    expect(host.notices.some(message => message.includes('corrupt stash data was quarantined to'))).toBe(true)
    expect(stash.entryCount).toBe(0)
  })

  it('says a newer bank is unavailable instead of quarantining it', async () => {
    const host = new FakeHost()
    const baseDir = scratchBase()
    writeFileSync(resolveStashPaths(CWD, baseDir).file, JSON.stringify({ version: 99 }))
    const stash = bank(host, { baseDir })
    await stash.open()
    expect(host.last()).toContain('stash unavailable')
  })
})
