import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PromptStash, type StashHost } from '@/stash.ts'
import { resolveStashPaths } from '@/stash/paths.ts'
import type { StashEntry } from '@/stash/schema.ts'
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
  pickChooser: (entries: readonly StashEntry[]) => string | undefined = () => undefined

  getEditorText(): string {
    return this.editorText
  }

  setEditorText(text: string): void {
    this.editorText = text
  }

  notice(message: string): void {
    this.notices.push(message)
  }

  async pick(entries: readonly StashEntry[]): Promise<string | undefined> {
    return this.pickChooser(entries)
  }

  async confirm(): Promise<boolean> {
    this.confirmations += 1
    return this.confirmResult
  }

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

  it('stores a draft given on the command line without touching the editor', async () => {
    const host = new FakeHost()
    const baseDir = scratchBase()
    const stash = bank(host, { baseDir })
    host.editorText = 'what I am still writing'
    await stash.stashText('park this instead')
    expect(host.editorText).toBe('what I am still writing')

    const reloaded = await loadStashStore(resolveStashPaths(CWD, baseDir))
    expect(reloaded.entries.map(entry => entry.text)).toEqual(['park this instead'])
  })

  it('prints the usage rather than storing a blank argument', async () => {
    const host = new FakeHost()
    const stash = bank(host)
    await stash.stashText('   ')
    expect(host.last()).toBe('usage: /stash <draft>')
    expect(stash.entryCount).toBe(0)
  })
})

describe('applying a draft', () => {
  it('fills an empty editor and keeps the entry', async () => {
    const host = new FakeHost()
    const stash = bank(host)
    await stash.stashText('one')
    await stash.stashText('two')
    await stash.apply(undefined)
    expect(host.editorText).toBe('two')
    expect(host.last()).toBe('Applied [0]')
    expect(stash.entryCount).toBe(2)
  })

  it('resolves an older draft by its displayed index', async () => {
    const host = new FakeHost()
    const stash = bank(host)
    await stash.stashText('one')
    await stash.stashText('two')
    await stash.apply('1')
    expect(host.editorText).toBe('one')
    expect(host.last()).toBe('Applied [1]')
  })

  it('refuses to overwrite a draft already in the editor', async () => {
    const host = new FakeHost()
    const stash = bank(host)
    await stash.stashText('parked')
    host.editorText = 'mine'
    await stash.apply(undefined)
    expect(host.editorText).toBe('mine')
    expect(host.last()).toBe('clear or stash the current draft before applying or popping')
    expect(stash.entryCount).toBe(1)
  })

  it('names a selector that matches nothing', async () => {
    const host = new FakeHost()
    const stash = bank(host)
    await stash.stashText('parked')
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
    await stash.stashText('one')
    await stash.stashText('two')
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
    await bank(other, { baseDir }).stashText('added elsewhere')
    await first.pop(undefined)
    expect(mine.editorText).toBe('added elsewhere')
    expect(first.entryCount).toBe(0)
  })

  it('refuses to overwrite a draft already in the editor', async () => {
    const host = new FakeHost()
    const stash = bank(host)
    await stash.stashText('parked')
    host.editorText = 'mine'
    await stash.pop(undefined)
    expect(host.editorText).toBe('mine')
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
    await stash.stashText('one')
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
    await stash.stashText('one')
    host.editorText = 'mine'
    await stash.drop(undefined)
    expect(host.editorText).toBe('mine')
    expect(host.last()).toBe('Dropped [0]')
    expect(stash.entryCount).toBe(0)
  })

  it('names a selector that matches nothing', async () => {
    const host = new FakeHost()
    const stash = bank(host)
    await stash.stashText('one')
    await stash.drop('ghost')
    expect(host.last()).toBe('no stash matching "ghost"')
    expect(stash.entryCount).toBe(1)
  })
})

describe('clearing the bank', () => {
  it('keeps every draft when the reader does not confirm', async () => {
    const host = new FakeHost()
    const stash = bank(host)
    await stash.stashText('one')
    await stash.stashText('two')
    host.confirmResult = false
    await stash.clear()
    expect(host.confirmations).toBe(1)
    expect(stash.entryCount).toBe(2)
  })

  it('removes every draft once the reader confirms', async () => {
    const host = new FakeHost()
    const stash = bank(host)
    await stash.stashText('one')
    await stash.stashText('two')
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
})

describe('listing drafts', () => {
  it('pops the entry the reader took', async () => {
    const host = new FakeHost()
    const baseDir = scratchBase()
    const stash = bank(host, { baseDir })
    await stash.stashText('one')
    await stash.stashText('two')
    host.pickChooser = entries => entries[1]?.id
    await stash.list('~/app')
    expect(host.editorText).toBe('one')
    expect(stash.entryCount).toBe(1)
    const reloaded = await loadStashStore(resolveStashPaths(CWD, baseDir))
    expect(reloaded.entries.map(entry => entry.text)).toEqual(['two'])
  })

  it('does nothing when the reader leaves the list', async () => {
    const host = new FakeHost()
    const stash = bank(host)
    await stash.stashText('one')
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
