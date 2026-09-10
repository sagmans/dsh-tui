import { describe, expect, it } from 'vitest'
import { commandMenu, createCompletionProvider } from '@/input/completion.ts'
import { LOCAL_COMMANDS, LOCAL_COMMAND_DESCRIPTIONS } from '@/input/submission.ts'

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
