import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { modelRouteKey } from '@/agent/model.ts'
import { defaultKeymap } from '@/input/actions.ts'
import { createModelChoice } from '@/surface/model-choice.ts'
import type { StatusFacts } from '@/ui/status.ts'

/** The fields the route owner never reads are stated once, so a case names only what it means. */
const facts = (overrides: Partial<StatusFacts> = {}): StatusFacts => ({
  chord: undefined,
  back: undefined,
  activity: 'idle',
  elapsedMs: undefined,
  provider: undefined,
  model: undefined,
  effort: undefined,
  agentPreset: undefined,
  preset: undefined,
  contextTokens: undefined,
  contextWindow: undefined,
  cacheRate: undefined,
  uncachedInputTokens: undefined,
  outputTokens: undefined,
  cwd: '/work',
  home: undefined,
  ...overrides,
})

/** The llm service, reduced to the calls the catalog makes. */
const catalogCtx = (llm: unknown): Context => ({ get: () => llm } as unknown as Context)

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

const harness = (
  resolveModelInfo: (provider: string, model: string) => Promise<unknown>,
  overrides: { readonly status?: Partial<StatusFacts>; readonly picked?: string } = {},
) => {
  const notices: string[] = []
  const route = createModelChoice(catalogCtx({
    listProviders: () => [{ id: 'opencode-go-session', name: 'OpenCode Go' }],
    listModels: async () => [{ id: 'space-bunny-free', name: 'Space Bunny Free' }],
    resolveModelInfo,
  }), {
    statusFacts: () => facts(overrides.status),
    keymap: defaultKeymap,
    openPicker: async () => overrides.picked,
    notice: message => notices.push(message),
    render: () => {},
  })
  return { route, notices }
}

const efforts = (...ids: readonly string[]): unknown => ({
  id: 'x',
  name: 'x',
  reasoning: { efforts: ids.map(id => ({ id, name: id })) },
})

const LEVELS_WITH_MAX = async (): Promise<unknown> => efforts('low', 'high', 'max')
/** A model pi-ai reports without reasoning metadata, which the task's own catalog does. */
const NO_LEVELS = async (): Promise<unknown> => ({ id: 'space-bunny-free', name: 'Space Bunny Free' })

describe('model switch effort fallback', () => {
  it('drops a level the chosen model does not offer and names it', async () => {
    const { route, notices } = harness(NO_LEVELS, {
      status: { provider: 'opencode-go-session', model: 'deepseek-flash', effort: 'max' },
    })
    route.adoptDefault()
    route.runModelCommand('opencode-go-session/space-bunny-free')
    await settle()
    expect(route.current()).toEqual({ provider: 'opencode-go-session', model: 'space-bunny-free' })
    expect(notices.at(-1)).toBe(
      'model set to opencode-go-session/space-bunny-free for the next step — dropped reasoning effort "max" because this model does not offer it',
    )
  })

  it('carries the level in force when the chosen model offers it', async () => {
    const { route, notices } = harness(LEVELS_WITH_MAX, {
      status: { provider: 'opencode-go-session', model: 'space-bunny-free', effort: 'max' },
    })
    route.adoptDefault()
    route.runModelCommand('opencode-go-session/deepseek-flash')
    await settle()
    expect(route.current()).toEqual({
      provider: 'opencode-go-session',
      model: 'deepseek-flash',
      reasoningEffort: 'max',
    })
    expect(notices.at(-1)).toBe('model set to opencode-go-session/deepseek-flash for the next step')
  })

  it('falls back the same way when the model is picked from the list', async () => {
    const { route, notices } = harness(NO_LEVELS, {
      status: { provider: 'opencode-go-session', model: 'deepseek-flash', effort: 'max' },
      picked: modelRouteKey({ provider: 'opencode-go-session', model: 'space-bunny-free' }),
    })
    route.adoptDefault()
    route.runModelCommand('')
    await settle()
    await settle()
    expect(route.current()).toEqual({ provider: 'opencode-go-session', model: 'space-bunny-free' })
    expect(notices.at(-1)).toBe(
      'model set to opencode-go-session/space-bunny-free for the next step — dropped reasoning effort "max" because this model does not offer it',
    )
  })

  it('adds no clause when no level is in force', async () => {
    const { route, notices } = harness(NO_LEVELS, {
      status: { provider: 'opencode-go-session', model: 'deepseek-flash' },
    })
    route.runModelCommand('opencode-go-session/space-bunny-free')
    await settle()
    expect(route.current()).toEqual({ provider: 'opencode-go-session', model: 'space-bunny-free' })
    expect(notices.at(-1)).toBe('model set to opencode-go-session/space-bunny-free for the next step')
  })

  it('lands the switch even when the levels cannot be read', async () => {
    const { route, notices } = harness(async () => {
      throw new Error('adapter is down')
    }, {
      status: { provider: 'opencode-go-session', model: 'deepseek-flash', effort: 'max' },
    })
    route.adoptDefault()
    route.runModelCommand('opencode-go-session/space-bunny-free')
    await settle()
    expect(route.current()).toEqual({ provider: 'opencode-go-session', model: 'space-bunny-free' })
    expect(notices.at(-1)).toBe('model set to opencode-go-session/space-bunny-free for the next step')
  })
})
