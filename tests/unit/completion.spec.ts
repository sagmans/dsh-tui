import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commandMenu, createCompletionProvider } from '@/input/completion.ts'
import { createFileIndex } from '@/input/file-search.ts'
import { LOCAL_COMMANDS, LOCAL_COMMAND_DESCRIPTIONS } from '@/input/submission.ts'

const signal = new AbortController().signal
const scratch: string[] = []
afterEach(() => {
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true })
})

function providerFor(paths: readonly string[], cwd = '/workspace', commands = [{ name: 'compact', description: 'compact' }]) {
  // A fixed listing keeps the menu's order a fact of the test rather than of
  // whatever tree the suite happens to run inside.
  return createCompletionProvider(commands, cwd, createFileIndex(cwd, { list: async () => paths.map(path => ({ path, isDirectory: !path.includes('.') })) }))
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
