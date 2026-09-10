import { describe, expect, it } from 'vitest'
import { ModelSwitch, parseModelArgument } from '@/agent/model.ts'

const PROVIDERS = [
  { id: 'zai-coding-cn', name: 'ZAI' },
  { id: 'kimi-coding', name: 'Kimi' },
]

describe('parseModelArgument', () => {
  it('asks for the current route when nothing is given', () => {
    expect(parseModelArgument('   ', PROVIDERS, undefined)).toEqual({ kind: 'current' })
  })

  it('switches on a complete route', () => {
    expect(parseModelArgument('kimi-coding/k2', PROVIDERS, undefined)).toEqual({
      kind: 'switch',
      choice: { provider: 'kimi-coding', model: 'k2' },
    })
  })

  it('lists a provider named on its own', () => {
    expect(parseModelArgument('kimi-coding', PROVIDERS, { provider: 'zai-coding-cn', model: 'glm-5.3' }))
      .toEqual({ kind: 'list-models', provider: 'kimi-coding' })
  })

  it('switches inside the route already in use when only a model is named', () => {
    expect(parseModelArgument('glm-5.4', PROVIDERS, { provider: 'zai-coding-cn', model: 'glm-5.3' }))
      .toEqual({ kind: 'switch', choice: { provider: 'zai-coding-cn', model: 'glm-5.4' } })
  })

  it('refuses a bare model when no route is in use', () => {
    const command = parseModelArgument('glm-5.4', PROVIDERS, undefined)
    expect(command.kind).toBe('invalid')
    expect(command.kind === 'invalid' && command.reason).toContain('zai-coding-cn')
  })

  it('treats a trailing slash as a bare model rather than a route', () => {
    expect(parseModelArgument('kimi-coding/', PROVIDERS, { provider: 'zai-coding-cn', model: 'glm-5.3' }))
      .toEqual({ kind: 'switch', choice: { provider: 'zai-coding-cn', model: 'kimi-coding/' } })
  })
})

describe('ModelSwitch', () => {
  it('remembers a choice until it is reset', () => {
    const modelSwitch = new ModelSwitch()
    expect(modelSwitch.current()).toBeUndefined()
    modelSwitch.choose({ provider: 'kimi-coding', model: 'k2', reasoningEffort: 'high' })
    expect(modelSwitch.current()).toEqual({ provider: 'kimi-coding', model: 'k2', reasoningEffort: 'high' })
    modelSwitch.reset()
    expect(modelSwitch.current()).toBeUndefined()
  })
})
