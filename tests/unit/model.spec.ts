import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { ModelSwitch, createModelCatalog, describeModelRoute, modelRouteKey, parseModelArgument, readModelRouteKey, type ModelChoice } from '@/agent/model.ts'

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

  it('reads the last segment of a complete route as the reasoning effort', () => {
    expect(parseModelArgument('kimi-coding/k2/high', PROVIDERS, undefined)).toEqual({
      kind: 'switch',
      choice: { provider: 'kimi-coding', model: 'k2', reasoningEffort: 'high' },
    })
  })

  it('keeps slashes inside the model when an effort follows them', () => {
    expect(parseModelArgument('openrouter/anthropic/claude/high', PROVIDERS, undefined)).toEqual({
      kind: 'switch',
      choice: { provider: 'openrouter', model: 'anthropic/claude', reasoningEffort: 'high' },
    })
  })

  it('treats a trailing slash after a model as part of the model, not an effort', () => {
    expect(parseModelArgument('kimi-coding/k2/', PROVIDERS, undefined)).toEqual({
      kind: 'switch',
      choice: { provider: 'kimi-coding', model: 'k2/' },
    })
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

  it('adopts a deployment default only while the reader has no choice', () => {
    const modelSwitch = new ModelSwitch()
    modelSwitch.adopt({ provider: 'kimi-coding', model: 'k2', reasoningEffort: 'max' })
    expect(modelSwitch.current()).toEqual({ provider: 'kimi-coding', model: 'k2', reasoningEffort: 'max' })
    modelSwitch.adopt({ provider: 'zai-coding-cn', model: 'glm-5.3' })
    expect(modelSwitch.current()).toEqual({ provider: 'kimi-coding', model: 'k2', reasoningEffort: 'max' })
    modelSwitch.reset()
    modelSwitch.adopt({ provider: 'zai-coding-cn', model: 'glm-5.3' })
    expect(modelSwitch.current()).toEqual({ provider: 'zai-coding-cn', model: 'glm-5.3' })
  })
})

/** The llm service, reduced to the calls the catalog makes. */
const catalogOf = (llm: unknown): ReturnType<typeof createModelCatalog> =>
  createModelCatalog({ get: () => llm } as unknown as Context)

describe('createModelCatalog reasoning efforts', () => {
  it('maps a route reasoning metadata to selectable entries', async () => {
    const catalog = catalogOf({
      listProviders: () => [],
      resolveModelInfo: async () => ({
        id: 'k2',
        name: 'K2',
        reasoning: {
          efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High', description: 'thorough' }],
          defaultEffort: 'high',
        },
      }),
    })
    expect(await catalog?.efforts('kimi-coding', 'k2')).toEqual({
      efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High', description: 'thorough' }],
      defaultEffort: 'high',
    })
  })

  it('reports nothing when the route declares no reasoning metadata', async () => {
    const catalog = catalogOf({ listProviders: () => [], resolveModelInfo: async () => ({ id: 'k2', name: 'K2' }) })
    expect(await catalog?.efforts('kimi-coding', 'k2')).toBeUndefined()
  })

  it('reports nothing when the deployment has no model resolver', async () => {
    const catalog = catalogOf({ listProviders: () => [] })
    expect(await catalog?.efforts('kimi-coding', 'k2')).toBeUndefined()
  })
})

describe('modelRouteKey', () => {
  it('round-trips a route whose model id contains the slash a reading would split on', () => {
    expect(readModelRouteKey(modelRouteKey({ provider: 'openrouter', model: 'anthropic/claude' })))
      .toEqual({ provider: 'openrouter', model: 'anthropic/claude' })
  })

  it('keeps apart two routes a slash-joined key would merge', () => {
    expect(modelRouteKey({ provider: 'a', model: 'b/c' }))
      .not.toBe(modelRouteKey({ provider: 'a/b', model: 'c' }))
  })

  it('refuses a string this surface never minted', () => {
    expect(readModelRouteKey('openrouter/anthropic/claude')).toBeUndefined()
    expect(readModelRouteKey('')).toBeUndefined()
  })
})

describe('describeModelRoute', () => {
  const route = { provider: 'kimi-coding', model: 'k2', name: 'K2 Turbo' }

  it('leads with the advertised name and keeps the id readable', () => {
    const row = describeModelRoute(route, undefined)
    expect(row.label).toBe('K2 Turbo')
    expect(row.description).toContain('kimi-coding')
    expect(row.description).toContain('k2')
    expect(row.current).toBe(false)
  })

  it('names the route in force with the effort in force', () => {
    const current: ModelChoice = { provider: 'kimi-coding', model: 'k2', reasoningEffort: 'high' }
    const row = describeModelRoute(route, current)
    expect(row.description).toContain('current')
    expect(row.description).toContain('high')
    expect(row.current).toBe(true)
  })

  it('leaves another route unmarked', () => {
    const row = describeModelRoute(route, { provider: 'zai-coding-cn', model: 'glm-5.3' })
    expect(row.current).toBe(false)
    expect(row.description).not.toContain('current')
  })
})
