/**
 * Taking a draft back: applying, popping, and dropping the one the reader
 * named, and what each refuses to overwrite.
 */

import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveStashPaths } from '@/stash/paths.ts'
import { loadStashStore, writeStashFile, type StashWriter } from '@/stash/store.ts'
import { SESSION, scratchDirs, scratchBase, FakeHost, bank } from './fixtures/stash.ts'

afterEach(() => {
  for (const directory of scratchDirs.splice(0)) rmSync(directory, { recursive: true, force: true })
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
  
      const reloaded = await loadStashStore(resolveStashPaths(SESSION, baseDir))
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
      const reloaded = await loadStashStore(resolveStashPaths(SESSION, baseDir))
      expect(reloaded.entryCount).toBe(1)
    })
  it('reports a committed removal as popped with a warning rather than a loss', async () => {
      const host = new FakeHost()
      const baseDir = scratchBase()
      await (await loadStashStore(resolveStashPaths(SESSION, baseDir))).add({ id: 'a', text: 'one' })
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
