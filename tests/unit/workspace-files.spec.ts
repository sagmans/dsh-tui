/**
 * What a listing may offer: the walk outside git, the listing inside it, and
 * the safety rules that drop a path escaping or steering the workspace.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { listWorkspaceFiles, walkFiles } from '@/input/workspace-files.ts'
import { scratch, scratchDir, signal, hasGit, directory, EMPTY_BLOB, gitRepo, track, withFakeGit, NOT_A_REPOSITORY } from './fixtures/workspace.ts'

afterEach(() => {
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('walkFiles', () => {
  it('walks a tree git does not own, skipping build litter no reader references', async () => {
      const root = scratchDir()
      mkdirSync(join(root, 'src'), { recursive: true })
      mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
      mkdirSync(join(root, '.git'), { recursive: true })
      writeFileSync(join(root, 'src', 'app.ts'), '')
      writeFileSync(join(root, 'README.md'), '')
      writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), '')
      const found = await walkFiles(root, signal)
      expect(found.map(entry => entry.path).sort()).toEqual(['README.md', 'src', 'src/app.ts'])
      expect(found.find(entry => entry.path === 'src')?.isDirectory).toBe(true)
    })
})

describe('listWorkspaceFiles', () => {
  it.skipIf(!hasGit)('lists a git workspace from git, so ignored files stay out', async () => {
      const root = scratchDir()
      execFileSync('git', ['init', '-q'], { cwd: root })
      writeFileSync(join(root, '.gitignore'), 'ignored.log\n')
      writeFileSync(join(root, 'a.ts'), '')
      writeFileSync(join(root, 'b.ts'), '')
      writeFileSync(join(root, 'ignored.log'), '')
      execFileSync('git', ['add', 'a.ts', '.gitignore'], { cwd: root })
      const found = await listWorkspaceFiles(root, signal)
      expect(found.map(entry => entry.path).sort()).toEqual(['.gitignore', 'a.ts', 'b.ts'])
    })
  it('falls back to the walker outside a git repository', async () => {
      const root = scratchDir()
      writeFileSync(join(root, 'notes.md'), '')
      const found = await listWorkspaceFiles(root, signal)
      expect(found.map(entry => entry.path)).toEqual(['notes.md'])
    })
})

describe('walkFiles safety', () => {
  it('never offers a path whose bytes the terminal would act on', async () => {
      const root = scratchDir()
      writeFileSync(join(root, 'safe.ts'), '')
      writeFileSync(join(root, 'bad\u001b[31m.ts'), '')
      expect((await walkFiles(root, signal)).map(entry => entry.path)).toEqual(['safe.ts'])
    })
  it('offers a symlink that stays inside and drops one that leaves', async () => {
      const root = scratchDir()
      const outside = scratchDir()
      writeFileSync(join(root, 'real.ts'), '')
      writeFileSync(join(outside, 'secret.env'), '')
      symlinkSync(join(root, 'real.ts'), join(root, 'inside-link.ts'))
      symlinkSync(join(outside, 'secret.env'), join(root, 'outside-link.ts'))
      symlinkSync(outside, join(root, 'outside-dir'))
      const paths = (await walkFiles(root, signal)).map(entry => entry.path)
      expect(paths).toContain('inside-link.ts')
      expect(paths).not.toContain('outside-link.ts')
      expect(paths).not.toContain('outside-dir')
    })
})

describe('listWorkspaceFiles containment', () => {
  it.skipIf(!hasGit)('never lists a tracked path that carries control characters', async () => {
      const root = gitRepo()
      writeFileSync(join(root, 'a.ts'), '')
      writeFileSync(join(root, 'bad\u001b.ts'), '')
      track(root, 'a.ts', 'bad\u001b.ts')
      expect((await listWorkspaceFiles(root, signal)).map(entry => entry.path)).toEqual(['a.ts'])
    })
  it.skipIf(!hasGit)('drops a tracked symlink that resolves outside the workspace', async () => {
      const root = gitRepo()
      const outside = scratchDir()
      writeFileSync(join(outside, 'secret.env'), '')
      writeFileSync(join(root, 'a.ts'), '')
      symlinkSync(join(outside, 'secret.env'), join(root, 'leak.env'))
      track(root, 'a.ts', 'leak.env')
      expect((await listWorkspaceFiles(root, signal)).map(entry => entry.path)).toEqual(['a.ts'])
    })
  it.skipIf(!hasGit)('drops an untracked symlink that resolves outside the workspace', async () => {
      const root = gitRepo()
      const outside = scratchDir()
      writeFileSync(join(outside, 'secret.env'), '')
      writeFileSync(join(root, 'a.ts'), '')
      symlinkSync(join(outside, 'secret.env'), join(root, 'leak.env'))
      track(root, 'a.ts')
      const paths = (await listWorkspaceFiles(root, signal)).map(entry => entry.path)
      expect(paths).toContain('a.ts')
      expect(paths).not.toContain('leak.env')
    })
  it.skipIf(!hasGit)('lists a tracked symlink that stays inside, as what it points at', async () => {
      const root = gitRepo()
      mkdirSync(join(root, 'src'))
      writeFileSync(join(root, 'src', 'app.ts'), '')
      symlinkSync(join(root, 'src'), join(root, 'src-link'))
      symlinkSync(join(root, 'src', 'app.ts'), join(root, 'alias.ts'))
      track(root, 'src/app.ts', 'src-link', 'alias.ts')
      const found = await listWorkspaceFiles(root, signal)
      expect(found.find(entry => entry.path === 'src-link')?.isDirectory).toBe(true)
      expect(found.find(entry => entry.path === 'alias.ts')?.isDirectory).toBe(false)
    })
  it.skipIf(!hasGit)('shows nothing rather than walking a repository whose index cannot be read', async () => {
      const root = gitRepo()
      writeFileSync(join(root, '.gitignore'), 'secret.env\n')
      writeFileSync(join(root, 'a.ts'), '')
      writeFileSync(join(root, 'secret.env'), '')
      track(root, 'a.ts', '.gitignore')
      writeFileSync(join(root, '.git', 'index'), 'not an index')
      expect(await listWorkspaceFiles(root, signal)).toEqual([])
    })
  it.skipIf(!hasGit)('lists a conflicted path once instead of once per index stage', async () => {
      const root = gitRepo()
      const stages = [1, 2, 3].map(stage => `100644 ${EMPTY_BLOB} ${stage}\ta.ts`).join('\n')
      execFileSync('git', ['update-index', '--index-info'], { cwd: root, input: `${stages}\n` })
      const found = await listWorkspaceFiles(root, signal)
      expect(found.filter(entry => entry.path === 'a.ts')).toHaveLength(1)
    })
  it.skipIf(process.platform === 'win32')('does not walk a repository git cannot answer for', async () => {
      const root = scratchDir()
      mkdirSync(join(root, '.git'))
      writeFileSync(join(root, '.gitignore'), 'secret.env\n')
      writeFileSync(join(root, 'secret.env'), '')
      writeFileSync(join(root, 'a.ts'), '')
      await withFakeGit('echo "fatal: something broke" >&2; exit 1', async () => {
        expect(await listWorkspaceFiles(root, signal)).toEqual([])
      })
    })
  it.skipIf(process.platform === 'win32')('walks when git says the directory is not a repository', async () => {
      const root = scratchDir()
      writeFileSync(join(root, 'a.ts'), '')
      await withFakeGit(NOT_A_REPOSITORY, async () => {
        expect((await listWorkspaceFiles(root, signal)).map(entry => entry.path)).toEqual(['a.ts'])
      })
    })
  it.skipIf(process.platform === 'win32')('does not walk a marked directory whatever git calls it', async () => {
      const root = scratchDir()
      mkdirSync(join(root, '.git'))
      writeFileSync(join(root, 'secret.env'), '')
      await withFakeGit(NOT_A_REPOSITORY, async () => {
        expect(await listWorkspaceFiles(root, signal)).toEqual([])
      })
    })
  it.skipIf(process.platform === 'win32')('does not walk a marker that points nowhere', async () => {
      const root = scratchDir()
      symlinkSync(join(root, 'gone'), join(root, '.git'))
      writeFileSync(join(root, 'secret.env'), '')
      await withFakeGit(NOT_A_REPOSITORY, async () => {
        expect(await listWorkspaceFiles(root, signal)).toEqual([])
      })
    })
  it.skipIf(!hasGit)('refuses the walk when the climb cannot reach a filesystem root', async () => {
      let deep = scratchDir()
      for (let level = 0; level < 41; level += 1) {
        deep = join(deep, 'd')
        mkdirSync(deep)
      }
      writeFileSync(join(deep, 'secret.env'), '')
      expect(await listWorkspaceFiles(deep, signal)).toEqual([])
    })
  it.skipIf(!hasGit)('never reads a tab inside an untracked name as index metadata', async () => {
      const root = gitRepo()
      writeFileSync(join(root, '.gitignore'), 'secret.env\n')
      writeFileSync(join(root, 'secret.env'), '')
      writeFileSync(join(root, 'junk\tsecret.env'), '')
      expect((await listWorkspaceFiles(root, signal)).map(entry => entry.path)).toEqual(['.gitignore'])
    })
  it.skipIf(process.platform === 'win32')('never spawns git for a caller that already looked away', async () => {
      const root = scratchDir()
      const marker = join(scratchDir(), 'spawned')
      await withFakeGit(`echo spawned > "${marker}"; exit 0`, async () => {
        const gone = new AbortController()
        gone.abort()
        expect(await listWorkspaceFiles(root, gone.signal)).toEqual([])
        expect(existsSync(marker)).toBe(false)
      })
    })
})
