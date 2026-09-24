/**
 * One index shared by callers that arrive together: its window, the scan they
 * share, the bound it runs under, and the proof each row passes.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFileIndex } from '@/input/file-index.ts'
import { scratch, scratchDir, signal } from './fixtures/workspace.ts'

afterEach(() => {
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('createFileIndex', () => {
  it('answers from the cache inside its window and rescans after it', async () => {
      let scans = 0
      let clock = 0
      const index = createFileIndex('/workspace', {
        now: () => clock,
        ttlMs: 1_000,
        list: async () => {
          scans += 1
          return [{ path: 'a.ts', isDirectory: false }]
        },
      })
      await index.candidates(signal)
      await index.candidates(signal)
      expect(scans).toBe(1)
      clock += 1_001
      await index.candidates(signal)
      expect(scans).toBe(2)
    })
})

describe('createFileIndex sharing', () => {
  it('keeps serving a shared scan after the first caller looks away', async () => {
      let release: (() => void) | undefined
      const gate = new Promise<void>(resolve => {
        release = resolve
      })
      const index = createFileIndex('/workspace', {
        list: async () => {
          await gate
          return [{ path: 'a.ts', isDirectory: false }]
        },
      })
      const abandoned = new AbortController()
      const waiting = new AbortController()
      const served = index.candidates(waiting.signal)
      const dropped = index.candidates(abandoned.signal)
      abandoned.abort()
      await expect(dropped).resolves.toEqual([])
      release?.()
      await expect(served).resolves.toEqual([{ path: 'a.ts', isDirectory: false }])
    })
  it('never starts a scan for a caller that already looked away', async () => {
      let scans = 0
      const index = createFileIndex('/workspace', {
        list: async () => {
          scans += 1
          return []
        },
      })
      const gone = new AbortController()
      gone.abort()
      await expect(index.candidates(gone.signal)).resolves.toEqual([])
      expect(scans).toBe(0)
    })
  it('releases a waiter when the scan outlives its bound, and keeps no answer from it', async () => {
      let release: (() => void) | undefined
      const gate = new Promise<void>(resolve => {
        release = resolve
      })
      let scans = 0
      const index = createFileIndex('/workspace', {
        scanTimeoutMs: 10,
        ttlMs: 0,
        list: async () => {
          scans += 1
          if (scans === 1) await gate
          return [{ path: 'a.ts', isDirectory: false }]
        },
      })
      await expect(index.candidates(signal)).resolves.toEqual([])
      release?.()
      await expect(index.candidates(signal)).resolves.toEqual([{ path: 'a.ts', isDirectory: false }])
    })
})

describe('createFileIndex reachability', () => {
  it('proves every path again, so a link planted after the listing cannot leave the workspace', async () => {
      const root = scratchDir()
      const outside = scratchDir()
      mkdirSync(join(root, 'src'))
      writeFileSync(join(root, 'safe.ts'), '')
      writeFileSync(join(root, 'src', 'app.ts'), '')
      writeFileSync(join(outside, 'secret.env'), '')
      symlinkSync(join(outside, 'secret.env'), join(root, 'leak.env'))
      rmSync(join(root, 'src'), { recursive: true })
      symlinkSync(outside, join(root, 'src'))
      const index = createFileIndex(root)
      await expect(index.reachable('safe.ts', signal)).resolves.toBe(true)
      await expect(index.reachable('leak.env', signal)).resolves.toBe(false)
      await expect(index.reachable('src/app.ts', signal)).resolves.toBe(false)
      await expect(index.reachable('gone.ts', signal)).resolves.toBe(false)
    })
  it('keeps a link that stays inside the workspace', async () => {
      const root = scratchDir()
      mkdirSync(join(root, 'src'))
      writeFileSync(join(root, 'src', 'app.ts'), '')
      symlinkSync(join(root, 'src', 'app.ts'), join(root, 'alias.ts'))
      await expect(createFileIndex(root).reachable('alias.ts', signal)).resolves.toBe(true)
    })
  it('never leaves a started proof unhandled when the caller looked away with it', async () => {
      const root = scratchDir()
      const gone = new AbortController()
      const index = createFileIndex(root, {
        resolve: async () => {
          gone.abort()
          throw Object.assign(new Error('gone'), { code: 'ENOENT' })
        },
      })
      const unhandled: unknown[] = []
      const watch = (reason: unknown): void => {
        unhandled.push(reason)
      }
      process.on('unhandledRejection', watch)
      try {
        await expect(index.reachable('a.ts', gone.signal)).resolves.toBe(false)
        await new Promise(resolve => setTimeout(resolve, 0))
      } finally {
        process.off('unhandledRejection', watch)
      }
      expect(unhandled).toEqual([])
    })
  it('leaves out a row whose proof never answers', async () => {
      const root = scratchDir()
      const index = createFileIndex(root, {
        resolve: () => new Promise<string>(() => {}),
        proofTimeoutMs: 10,
      })
      await expect(index.reachable('a.ts', signal)).resolves.toBe(false)
    })
  it('stops proving as soon as the caller looks away', async () => {
      const root = scratchDir()
      const index = createFileIndex(root, { resolve: () => new Promise<string>(() => {}) })
      const gone = new AbortController()
      const proof = index.reachable('a.ts', gone.signal)
      gone.abort()
      await expect(proof).resolves.toBe(false)
    })
  it('proves nothing for a caller that already looked away', async () => {
      const root = scratchDir()
      writeFileSync(join(root, 'safe.ts'), '')
      const gone = new AbortController()
      gone.abort()
      await expect(createFileIndex(root).reachable('safe.ts', gone.signal)).resolves.toBe(false)
    })
})
