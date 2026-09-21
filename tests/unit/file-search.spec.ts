import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  atToken,
  atValue,
  createFileIndex,
  listWorkspaceFiles,
  rankFiles,
  walkFiles,
  type Candidate,
} from '@/input/file-search.ts'

const scratch: string[] = []
function scratchDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-files-'))
  scratch.push(root)
  return root
}
afterEach(() => {
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true })
})

const signal = new AbortController().signal
const hasGit = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true } catch { return false }
})()


const file = (path: string): Candidate => ({ path, isDirectory: false })
const directory = (path: string): Candidate => ({ path, isDirectory: true })

describe('atToken', () => {
  it('reads the fragment after an at-sign the reader just typed', () => {
    expect(atToken('@edi')).toEqual({ prefix: '@edi', query: 'edi', quoted: false })
  })

  it('reads the token that follows a space, not the whole line', () => {
    expect(atToken('look at @src/ui')).toEqual({ prefix: '@src/ui', query: 'src/ui', quoted: false })
  })

  it('ignores an at-sign inside a word', () => {
    expect(atToken('mail@example.com')).toBeUndefined()
  })

  it('reads a quoted token so a path with spaces can be typed', () => {
    expect(atToken('@"my fi')).toEqual({ prefix: '@"my fi', query: 'my fi', quoted: true })
  })

  it('stops at a quote the reader closed', () => {
    expect(atToken('@"my file" ')).toBeUndefined()
  })

  it('lets the reader keep the dot-slash habit', () => {
    expect(atToken('@./src')).toEqual({ prefix: '@./src', query: 'src', quoted: false })
  })

  it('offers the top level when only the at-sign is typed', () => {
    expect(atToken('@')).toEqual({ prefix: '@', query: '', quoted: false })
  })
})

describe('rankFiles', () => {
  it('lists top-level entries for an empty fragment, directories first', () => {
    const candidates = [file('src/deep.ts'), directory('src'), file('README.md'), file('src.ts')]
    expect(rankFiles('', candidates, 20).map(entry => entry.path)).toEqual(['src', 'README.md', 'src.ts'])
  })

  /**
   * The order below is the order the fzf binary prints for the same fragment
   * and paths, so the file list ranks the way the finder readers know.
   */
  it('ranks a workspace the way fzf ranks the same paths', () => {
    const candidates = [
      file('docs/editor-notes/old.md'),
      file('tests/unit/editor.spec.ts'),
      file('src/ui/editor.ts'),
    ]
    expect(rankFiles('edtr', candidates, 20).map(entry => entry.path)).toEqual([
      'src/ui/editor.ts',
      'docs/editor-notes/old.md',
      'tests/unit/editor.spec.ts',
    ])
  })

  it('lets a fragment scoped to a directory lead with that directory', () => {
    const candidates = [file('src/input/completion.ts'), file('src/ui/editor.ts')]
    expect(rankFiles('src/ui', candidates, 20).map(entry => entry.path)).toEqual(['src/ui/editor.ts', 'src/input/completion.ts'])
  })

  it('keeps a directory above a file it ties with, so it can be opened', () => {
    const candidates = [file('src/app.ts'), directory('src/app')]
    expect(rankFiles('app', candidates, 20).map(entry => entry.path)).toEqual(['src/app', 'src/app.ts'])
  })

  it('holds the list to the suggestions a menu can show', () => {
    const candidates = Array.from({ length: 25 }, (_, index) => file(`src/file-${index}.ts`))
    expect(rankFiles('file', candidates, 20)).toHaveLength(20)
  })

  it('matches a path whose spaces were quoted', () => {
    const candidates = [file('docs/my file.md'), file('docs/other.md')]
    expect(rankFiles('my file', candidates, 20).map(entry => entry.path)).toEqual(['docs/my file.md'])
  })
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
/** Git's empty blob, which an index entry may name without an object behind it. */
const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'

function gitRepo(): string {
  const root = scratchDir()
  execFileSync('git', ['init', '-q'], { cwd: root })
  return root
}

function track(root: string, ...paths: string[]): void {
  execFileSync('git', ['add', '--', ...paths], { cwd: root })
}

/**
 * Put a script on PATH as `git`, so the failure branches are reached without
 * waiting for a real repository to break in the same way.
 */
async function withFakeGit(script: string, run: () => Promise<void>): Promise<void> {
  const bin = scratchDir()
  writeFileSync(join(bin, 'git'), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
  const previous = process.env.PATH ?? ''
  process.env.PATH = `${bin}:${previous}`
  try {
    await run()
  } finally {
    process.env.PATH = previous
  }
}

const NOT_A_REPOSITORY = 'echo "fatal: not a git repository (or any of the parent directories): .git" >&2; exit 128'

describe('atValue', () => {
  it('leaves a path that ends no token bare', () => {
    expect(atValue('src/ui/editor.ts', false, false)).toBe('@src/ui/editor.ts')
  })

  it('closes a file pick, because the reader is done with that token', () => {
    const value = atValue('docs/my file.md', false, false)
    expect(value).toBe('@"docs/my file.md"')
    expect(atToken(value + ' ')).toBeUndefined()
  })

  it('keeps a directory pick open while it needs quoting, so the reader can drill in', () => {
    const value = atValue('docs/my dir/', false, true)
    expect(value).toBe('@"docs/my dir/')
    expect(atToken(value)).toEqual({ prefix: value, query: 'docs/my dir/', quoted: true })
  })

  it('escapes a quote inside a path instead of ending the token there', () => {
    const value = atValue('docs/my" dir/', false, true)
    expect(atToken(value)).toEqual({ prefix: value, query: 'docs/my" dir/', quoted: true })
  })

  it('quotes every character that would end a token', () => {
    for (const path of ["a'b/", 'a=b/', 'a\tb/', 'a b/']) {
      expect(atToken(atValue(path, false, true))?.query).toBe(path)
    }
  })

  it('round-trips a backslash that sits beside a space', () => {
    expect(atToken(atValue('a\\ b/', false, true))?.query).toBe('a\\ b/')
  })

  it('keeps a token quoted once the reader opened the quote', () => {
    expect(atValue('src', true, false)).toBe('@"src"')
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

  it('proves nothing for a caller that already looked away', async () => {
    const root = scratchDir()
    writeFileSync(join(root, 'safe.ts'), '')
    const gone = new AbortController()
    gone.abort()
    await expect(createFileIndex(root).reachable('safe.ts', gone.signal)).resolves.toBe(false)
  })
})
