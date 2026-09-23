import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commandMenu, createAnswerCompletionProvider, createCompletionProvider } from '@/input/completion.ts'
import { createFileIndex, type FileIndex } from '@/input/file-search.ts'
import { LOCAL_COMMANDS, LOCAL_COMMAND_DESCRIPTIONS } from '@/input/submission.ts'

const signal = new AbortController().signal
const scratch: string[] = []
afterEach(() => {
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true })
})

function indexFor(paths: readonly string[], reachable: (path: string) => boolean = () => true): FileIndex {
  // A fixed listing keeps the menu's order a fact of the test rather than of
  // whatever tree the suite happens to run inside, and a fixed answer to
  // reachability keeps a row from depending on a path no test wrote.
  const candidates = paths.map(path => ({ path, isDirectory: !path.includes('.') }))
  return { candidates: async () => candidates, reachable: async path => reachable(path) }
}

function providerFor(paths: readonly string[], cwd = '/workspace', commands = [{ name: 'compact', description: 'compact' }]) {
  return createCompletionProvider(commands, cwd, indexFor(paths))
}


describe('commandMenu', () => {
  it('completes local commands without the slash the reader already typed', () => {
    const menu = commandMenu([])
    expect(menu.map(item => item.name)).toEqual(LOCAL_COMMANDS.map(name => name.slice(1)))
  })

  it('describes every local command', () => {
    for (const name of LOCAL_COMMANDS) {
      expect(LOCAL_COMMAND_DESCRIPTIONS[name]).toBeTruthy()
    }
    expect(commandMenu([]).every(item => (item.description ?? '') !== '')).toBe(true)
  })

  it('lists the registry commands after the local ones', () => {
    const menu = commandMenu([{ name: 'plan', description: 'toggle plan mode' }])
    expect(menu.at(-1)).toEqual({ name: 'plan', description: 'toggle plan mode' })
  })

  it('builds a provider that can also complete paths', () => {
    const provider = createCompletionProvider([{ name: 'compact', description: 'compact' }], '/tmp')
    expect(typeof provider.getSuggestions).toBe('function')
    expect(typeof provider.applyCompletion).toBe('function')
  })
})

describe('file completion on the at-sign', () => {
  it('answers a fragment with the workspace rows that match it', async () => {
    const provider = providerFor(['src/ui/editor.ts', 'docs/readme.md'])
    const found = await provider.getSuggestions(['@edi'], 0, 4, { signal })
    expect(found?.prefix).toBe('@edi')
    expect(found?.items.map(item => item.value)).toEqual(['@src/ui/editor.ts'])
    expect(found?.items[0]?.label).toBe('editor.ts')
    expect(found?.items[0]?.description).toBe('src/ui/editor.ts')
  })

  it('offers a directory with a trailing slash so the reader keeps typing', async () => {
    const provider = providerFor(['src/ui/editor.ts', 'src/ui'])
    const found = await provider.getSuggestions(['@src/ui'], 0, 7, { signal })
    expect(found?.items[0]?.value).toBe('@src/ui/')
    expect(found?.items[0]?.label).toBe('ui/')
  })

  it('quotes a path that holds a space, whether or not the reader opened the quote', async () => {
    const provider = providerFor(['docs/my file.md'])
    const found = await provider.getSuggestions(['@"my fi'], 0, 7, { signal })
    expect(found?.prefix).toBe('@"my fi')
    expect(found?.items[0]?.value).toBe('@"docs/my file.md"')
  })

  it('closes the menu when nothing matches', async () => {
    const provider = providerFor(['src/ui/editor.ts'])
    await expect(provider.getSuggestions(['@zzz'], 0, 4, { signal })).resolves.toBeNull()
  })

  it('leaves an absolute or home path to the path completion underneath', async () => {
    const provider = createCompletionProvider([], '/workspace', createFileIndex('/workspace', {
      list: async () => {
        throw new Error('the workspace index must not answer for a path outside it')
      },
    }))
    await expect(provider.getSuggestions(['@/etc/hosts'], 0, 10, { signal })).resolves.toBeNull()
    await expect(provider.getSuggestions(['@~/notes'], 0, 8, { signal })).resolves.toBeNull()
  })

  it('still completes commands and paths when no at-sign is typed', async () => {
    const provider = providerFor([])
    const command = await provider.getSuggestions(['/com'], 0, 4, { signal })
    expect(command?.items.map(item => item.value)).toEqual(['compact'])

    const root = mkdtempSync(join(tmpdir(), 'dsh-tab-'))
    scratch.push(root)
    writeFileSync(join(root, 'alpha.txt'), '')
    const paths = createCompletionProvider([], root, createFileIndex(root, { list: async () => [] }))
    const file = await paths.getSuggestions(['alpha'], 0, 5, { signal, force: true })
    expect(file?.items.map(item => item.value)).toEqual(['alpha.txt'])
  })
})

describe("the menu a question's answer is written with", () => {
  it("offers the workspace's files to an answer", async () => {
    const provider = createAnswerCompletionProvider('/workspace', indexFor(['src/ui/editor.ts', 'docs/readme.md']))
    const found = await provider.getSuggestions(['@edi'], 0, 4, { signal })
    expect(found?.items.map(item => item.value)).toEqual(['@src/ui/editor.ts'])
  })

  it('offers an answer no command at all', async () => {
    // An answer is text the model reads, so a line the surface would run has no
    // place in its menu: the bar is borrowed, not turned into a prompt bar.
    const provider = createAnswerCompletionProvider('/workspace', indexFor(['src/ui/editor.ts']))
    await expect(provider.getSuggestions(['/com'], 0, 4, { signal })).resolves.toBeNull()
    await expect(provider.getSuggestions(['/'], 0, 1, { signal })).resolves.toBeNull()
  })

  it('still completes a path the base provider knows', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-answer-tab-'))
    scratch.push(root)
    writeFileSync(join(root, 'alpha.txt'), '')
    const provider = createAnswerCompletionProvider(root, createFileIndex(root, { list: async () => [] }))
    const file = await provider.getSuggestions(['alpha'], 0, 5, { signal, force: true })
    expect(file?.items.map(item => item.value)).toEqual(['alpha.txt'])
  })
})

describe('at-sign rows the menu must not draw', () => {
  it('keeps a quoted directory pick open so the reader can drill into it', async () => {
    const provider = providerFor(['docs/my"dir/notes.md', 'docs/my"dir'])
    const found = await provider.getSuggestions(['@"my'], 0, 4, { signal })
    const chosen = found?.items.find(item => item.value.endsWith('dir/'))
    expect(chosen?.value).toBe('@"docs/my\\"dir/')
    const next = await provider.getSuggestions([chosen?.value + 'n'], 0, (chosen?.value.length ?? 0) + 1, { signal })
    expect(next?.items.map(item => item.value)).toEqual(['@"docs/my\\"dir/notes.md"'])
  })

  it('does not offer a directory the reader could never narrow further', async () => {
    const provider = providerFor(['my docs/notes.md', 'my docs'])
    const found = await provider.getSuggestions(['@my'], 0, 3, { signal })
    expect(found?.items.map(item => item.value)).toEqual(['@"my docs/notes.md"'])
  })

  it('never offers a row whose path could drive the terminal', async () => {
    const provider = providerFor(['bad\u001b[31m.ts', 'safe.ts'])
    const found = await provider.getSuggestions(['@'], 0, 1, { signal })
    expect(found?.items.map(item => item.value)).toEqual(['@safe.ts'])
  })

  it('never offers a row that climbs out of the workspace', async () => {
    const provider = providerFor(['../etc/passwd', '/etc/hosts', 'safe.ts'])
    const found = await provider.getSuggestions(['@'], 0, 1, { signal })
    expect(found?.items.map(item => item.value)).toEqual(['@safe.ts'])
  })

  it('drops a row the workspace no longer lets the prompt name', async () => {
    const provider = createCompletionProvider([], '/workspace', indexFor(['src/real.ts', 'src/gone.ts'], path => path.endsWith('real.ts')))
    const found = await provider.getSuggestions(['@src'], 0, 4, { signal })
    expect(found?.items.map(item => item.value)).toEqual(['@src/real.ts'])
  })

  it('drops a row a link now points out of the workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-menu-'))
    const outside = mkdtempSync(join(tmpdir(), 'dsh-outside-'))
    scratch.push(root, outside)
    writeFileSync(join(outside, 'secret.env'), '')
    writeFileSync(join(root, 'safe.ts'), '')
    symlinkSync(join(outside, 'secret.env'), join(root, 'leak.env'))
    const provider = createCompletionProvider([], root, createFileIndex(root, {
      list: async () => [
        { path: 'leak.env', isDirectory: false },
        { path: 'safe.ts', isDirectory: false },
      ],
    }))
    const found = await provider.getSuggestions(['@'], 0, 1, { signal })
    expect(found?.items.map(item => item.value)).toEqual(['@safe.ts'])
  })

  it('escapes a direction override in the text it draws', async () => {
    const provider = providerFor(['src/\u202egnp.exe'])
    const found = await provider.getSuggestions(['@gnp'], 0, 4, { signal })
    expect(found?.items[0]?.label).toBe('\\u202Egnp.exe')
    expect(found?.items[0]?.description).toBe('src/\\u202Egnp.exe')
  })
})
