import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { modelRouteKey } from '@/agent/model.ts'
import { defaultKeymap } from '@/input/actions.ts'
import { createModelChoice } from '@/surface/model-choice.ts'
import type { Picker } from '@/surface/modal-input.ts'
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

/** Discovery is observed at the real controller's picker and notice/render ports. */
const discoveryHarness = (llm: unknown) => {
  const notices: string[] = []
  const renderedNotices: (string | undefined)[] = []
  const openPicker = vi.fn<(picker: Picker) => Promise<string | undefined>>().mockResolvedValue(undefined)
  const route = createModelChoice(catalogCtx(llm), {
    statusFacts: facts,
    keymap: defaultKeymap,
    openPicker,
    notice: message => notices.push(message),
    render: () => renderedNotices.push(notices.at(-1)),
  })
  return { route, notices, renderedNotices, openPicker }
}

describe('model discovery diagnostics', () => {
  it.each(['picker', 'text'])('sanitizes provider controls in %s discovery diagnostics', async form => {
    const provider = '\u202ebroken-lab\u0007'
    const { route, notices, renderedNotices } = discoveryHarness({
      listProviders: () => [{ id: provider }],
      listModels: async () => {
        throw new Error('adapter failed')
      },
    })

    route.runModelCommand(form === 'picker' ? '' : provider)
    await settle()
    expect(notices).toEqual([
      'broken-lab: could not list models; check provider configuration and credentials, then retry /model',
    ])
    expect(renderedNotices.at(-1)).toBe(notices[0])
  })

  it('reports text-form discovery failure without inspecting the raw error object', async () => {
    const error = {
      message: 'private-token',
      request: { body: 'private-prompt' },
      toString: vi.fn(() => 'private-token private-prompt'),
    }
    const { route, notices, renderedNotices, openPicker } = discoveryHarness({
      listProviders: () => [{ id: 'broken-lab' }],
      listModels: () => {
        throw error
      },
    })

    route.runModelCommand('broken-lab')
    await settle()
    expect(notices).toEqual([
      'broken-lab: could not list models; check provider configuration and credentials, then retry /model',
    ])
    expect(renderedNotices.at(-1)).toBe(notices[0])
    expect(error.toString).not.toHaveBeenCalled()
    expect(openPicker).not.toHaveBeenCalled()
  })

  it('contains synchronous provider-list failure, distinguishes empty, and allows retry', async () => {
    const listProviders = vi.fn<() => { id: string }[]>()
      .mockImplementationOnce(() => {
        throw new Error('directory failed with private-token')
      })
      .mockReturnValueOnce([])
      .mockReturnValue([{ id: 'healthy-lab' }])
    const { route, notices, renderedNotices, openPicker } = discoveryHarness({
      listProviders,
      listModels: async () => [{ id: 'custom-model', name: 'Custom Model' }],
    })

    expect(() => route.runModelCommand('')).not.toThrow()
    expect(notices).toEqual(['could not list providers; check provider configuration, then retry /model'])
    expect(renderedNotices.at(-1)).toBe(notices[0])
    expect(openPicker).not.toHaveBeenCalled()

    route.runModelCommand('')
    expect(notices.at(-1)).toBe('no provider is configured; add one before choosing a model')
    expect(openPicker).not.toHaveBeenCalled()

    route.runModelCommand('')
    await settle()
    expect(listProviders).toHaveBeenCalledTimes(3)
    expect(openPicker).toHaveBeenCalledTimes(1)
    expect(openPicker.mock.calls[0]![0].card().rows).toHaveLength(1)
  })

  it('reports a failed provider without hiding or blocking healthy model rows', async () => {
    let failDiscovery!: (error: unknown) => void
    const unavailable = new Promise<never>((_resolve, reject) => {
      failDiscovery = reject
    })
    const { route, notices, renderedNotices, openPicker } = discoveryHarness({
      listProviders: () => [{ id: 'healthy-lab' }, { id: 'broken-lab' }],
      listModels: (provider: string) => provider === 'broken-lab'
        ? unavailable
        : Promise.resolve([{ id: 'custom-model', name: 'Custom Model' }]),
    })
    let choose!: (id: string | undefined) => void
    openPicker.mockImplementation(() => new Promise(resolve => {
      choose = resolve
    }))

    route.runModelCommand('')
    await settle()
    const picker = openPicker.mock.calls[0]![0]
    expect(picker.card().rows).toEqual([
      { label: 'Custom Model', description: 'healthy-lab · custom-model', current: true },
    ])
    failDiscovery(new Error('Authorization: Bearer private-token; request body: private-prompt'))
    await settle()
    expect(notices).toEqual([
      'broken-lab: could not list models; check provider configuration and credentials, then retry /model',
    ])
    expect(renderedNotices.at(-1)).toBe(notices[0])
    expect(picker.card().rows).toHaveLength(1)
    const action = picker.handleKey('\r')
    expect(action).toEqual({ kind: 'pick', id: modelRouteKey({ provider: 'healthy-lab', model: 'custom-model' }) })
    if (action?.kind === 'pick') choose(action.id)
    await settle()
    expect(route.current()).toEqual({ provider: 'healthy-lab', model: 'custom-model' })
  })
})

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
