import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atToken, createFileIndex, listWorkspaceFiles, rankFiles, walkFiles, type Candidate } from '@/input/file-search.ts'

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
