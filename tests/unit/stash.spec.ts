/**
 * Parking the editor draft: what is written, what is refused, and what the bar
 * keeps when the write never lands.
 */

import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveStashPaths } from '@/stash/paths.ts'
import { StashCommittedError } from '@/stash/lock.ts'
import { loadStashStore, writeStashFile, type StashWriter } from '@/stash/store.ts'
import { SESSION, scratchDirs, scratchBase, FakeHost, bank } from './fixtures/stash.ts'

afterEach(() => {
  for (const directory of scratchDirs.splice(0)) rmSync(directory, { recursive: true, force: true })
})

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
  
      const reloaded = await loadStashStore(resolveStashPaths(SESSION, baseDir))
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
  
      const reloaded = await loadStashStore(resolveStashPaths(SESSION, baseDir))
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
      // The answer is the same text as the draft, so a clear that only compares the
      // bar's contents cannot tell them apart.
      const borrowing: StashWriter = async (file, contents) => {
        host.editorAvailable = false
        host.editorText = 'parked'
        return await writeStashFile(file, contents)
      }
      const stash = bank(host, { baseDir, write: borrowing })
      await stash.stashEditor('parked')
      expect(host.editorText).toBe('parked')
      expect(host.editorAvailable).toBe(false)
      expect(host.last()).toBe('Stashed [0]')
    })
})

describe('open', () => {
  it('reports where a corrupt bank was quarantined', async () => {
      const host = new FakeHost()
      const baseDir = scratchBase()
      writeFileSync(resolveStashPaths(SESSION, baseDir).file, 'not json')
      const stash = bank(host, { baseDir })
      await stash.open()
      expect(host.notices.some(message => message.includes('corrupt stash data was quarantined to'))).toBe(true)
      expect(stash.entryCount).toBe(0)
    })
  it('says a newer bank is unavailable instead of quarantining it', async () => {
      const host = new FakeHost()
      const baseDir = scratchBase()
      writeFileSync(resolveStashPaths(SESSION, baseDir).file, JSON.stringify({ version: 99 }))
      const stash = bank(host, { baseDir })
      await stash.open()
      expect(host.last()).toContain('stash unavailable')
    })
})
