/**
 * Whose drafts these are: the bank as a whole, the list the reader picks from,
 * and the scope that keeps one session out of another.
 */

import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveStashPaths } from '@/stash/paths.ts'
import { loadStashStore } from '@/stash/store.ts'
import { SESSION, OTHER_SESSION, SESSION_CHANGED, scratchDirs, scratchBase, FakeHost, bank, movingWriter } from './fixtures/stash.ts'

afterEach(() => {
  for (const directory of scratchDirs.splice(0)) rmSync(directory, { recursive: true, force: true })
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
  
      const reloaded = await loadStashStore(resolveStashPaths(SESSION, baseDir))
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
      const reloaded = await loadStashStore(resolveStashPaths(SESSION, baseDir))
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

describe('session scope', () => {
  it('never shows another session the drafts this one parked', async () => {
      const baseDir = scratchBase()
      await bank(new FakeHost(), { baseDir }).stashEditor('mine')
      await bank(new FakeHost(), { baseDir, sessionId: () => OTHER_SESSION }).stashEditor('theirs')
  
      const mineHost = new FakeHost()
      const mine = bank(mineHost, { baseDir })
      await mine.apply(undefined)
      expect(mine.entryCount).toBe(1)
      expect(mineHost.editorText).toBe('mine')
  
      const theirsHost = new FakeHost()
      const theirs = bank(theirsHost, { baseDir, sessionId: () => OTHER_SESSION })
      await theirs.apply(undefined)
      expect(theirs.entryCount).toBe(1)
      expect(theirsHost.editorText).toBe('theirs')
    })
  it('clears only the drafts of this session', async () => {
      const baseDir = scratchBase()
      await bank(new FakeHost(), { baseDir }).stashEditor('mine')
      await bank(new FakeHost(), { baseDir, sessionId: () => OTHER_SESSION }).stashEditor('theirs')
  
      const mineHost = new FakeHost()
      const mine = bank(mineHost, { baseDir })
      mineHost.confirmResult = true
      await mine.clear()
      expect(mineHost.last()).toBe('Cleared 1 draft')
  
      const theirsHost = new FakeHost()
      const theirs = bank(theirsHost, { baseDir, sessionId: () => OTHER_SESSION })
      await theirs.open()
      expect(theirs.entryCount).toBe(1)
    })
  /**
     * A resume keeps the session id, which is the only reason a draft parked
     * before a restart is still findable afterwards.
     */
    it('finds the drafts the same session parked before a restart', async () => {
      const baseDir = scratchBase()
      await bank(new FakeHost(), { baseDir }).stashEditor('parked before the restart')
      const host = new FakeHost()
      const resumed = bank(host, { baseDir })
      await resumed.open()
      expect(resumed.entryCount).toBe(1)
      await resumed.apply(undefined)
      expect(host.editorText).toBe('parked before the restart')
    })
  it('follows the surface to another session and back', async () => {
      const baseDir = scratchBase()
      let session = SESSION
      const host = new FakeHost()
      const stash = bank(host, { baseDir, sessionId: () => session })
      await stash.stashEditor('first')
      session = OTHER_SESSION
      await stash.open()
      expect(stash.entryCount).toBe(0)
      await stash.stashEditor('second')
      session = SESSION
      await stash.open()
      expect(stash.entryCount).toBe(1)
      await stash.apply(undefined)
      expect(host.editorText).toBe('first')
    })
  /**
     * The queue can hold a command past a session switch. A command names the
     * bank the reader was looking at when they asked for it, so it must not
     * resolve the session again when its turn comes.
     */
    it('drops from the session that issued the command, not the one on screen later', async () => {
      const baseDir = scratchBase()
      await bank(new FakeHost(), { baseDir, sessionId: () => OTHER_SESSION }).stashEditor('theirs')
  
      let session = SESSION
      const host = new FakeHost()
      const stash = bank(host, {
        baseDir,
        write: movingWriter(() => { session = OTHER_SESSION }),
        sessionId: () => session,
      })
  
      // The first write has already resolved this session when the surface moves,
      // and the drop behind it was asked for on this session too.
      const parked = stash.stashEditor('parked')
      const dropped = stash.drop(undefined)
      const opened = stash.open()
      await Promise.all([parked, dropped, opened])
  
      const mine = await loadStashStore(resolveStashPaths(SESSION, baseDir))
      expect(mine.entries).toEqual([])
      const theirs = await loadStashStore(resolveStashPaths(OTHER_SESSION, baseDir))
      expect(theirs.entries.map(entry => entry.text)).toEqual(['theirs'])
      expect(stash.entryCount).toBe(1)
    })
  it('keeps a queued pop out of the bar of the session the surface moved to', async () => {
      const baseDir = scratchBase()
      await bank(new FakeHost(), { baseDir }).stashEditor('mine')
      await bank(new FakeHost(), { baseDir, sessionId: () => OTHER_SESSION }).stashEditor('theirs')
  
      let session = SESSION
      const host = new FakeHost()
      const stash = bank(host, {
        baseDir,
        write: movingWriter(() => { session = OTHER_SESSION }),
        sessionId: () => session,
      })
  
      const held = stash.stashEditor('holding the queue')
      const popped = stash.pop(undefined)
      const opened = stash.open()
      await Promise.all([held, popped, opened])
  
      // Nothing was taken from the bank the pop named, and nothing was typed into
      // the bar that now belongs to the session the surface moved to.
      expect(host.editorText).toBe('holding the queue')
      expect(host.notices).toContain(SESSION_CHANGED)
      const mine = await loadStashStore(resolveStashPaths(SESSION, baseDir))
      expect(mine.entries.map(entry => entry.text)).toEqual(['holding the queue', 'mine'])
      const theirs = await loadStashStore(resolveStashPaths(OTHER_SESSION, baseDir))
      expect(theirs.entries.map(entry => entry.text)).toEqual(['theirs'])
    })
  it('parks the bar the reader had when the command was issued', async () => {
      const baseDir = scratchBase()
      let session = SESSION
      const host = new FakeHost()
      const stash = bank(host, {
        baseDir,
        write: movingWriter(() => { session = OTHER_SESSION }),
        sessionId: () => session,
      })
  
      const first = stash.stashEditor('first')
      host.editorText = 'the draft the reader sees'
      const second = stash.stashEditor()
      host.editorText = 'typed in the other session'
      const opened = stash.open()
      await Promise.all([first, second, opened])
  
      const mine = await loadStashStore(resolveStashPaths(SESSION, baseDir))
      expect(mine.entries.map(entry => entry.text)).toEqual(['the draft the reader sees', 'first'])
      expect(host.editorText).toBe('typed in the other session')
    })
})
