import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { modelRouteKey } from '@/agent/model.ts'
import { defaultKeymap } from '@/input/actions.ts'
import { PROVIDER_DEFAULT_EFFORT_ID } from '@/ui/picker.ts'
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

/**
 * The route owner with every port recorded.
 *
 * The status facts are read per call, so a case can move the route the surface
 * reports the way a settings edit does between two presses.
 */
const recordingHarness = (
  llm: unknown,
  options: { readonly statusFacts?: () => Partial<StatusFacts> } = {},
) => {
  const notices: string[] = []
  const renders: number[] = []
  const openPicker = vi.fn<(picker: Picker) => Promise<string | undefined>>().mockResolvedValue(undefined)
  const route = createModelChoice(catalogCtx(llm), {
    statusFacts: () => facts(options.statusFacts?.()),
    keymap: defaultKeymap,
    openPicker,
    notice: message => notices.push(message),
    render: () => renders.push(1),
  })
  return { route, notices, renders, openPicker }
}

/** A deployment with one provider, and whichever catalogue the case scripts. */
const llmWith = (resolveModelInfo: (provider: string, model: string) => Promise<unknown>): unknown => ({
  listProviders: () => [{ id: 'lab', name: 'Lab' }],
  listModels: async () => [],
  resolveModelInfo,
})

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

describe('model choice without a directory', () => {
  it('says a profile with no llm service cannot list or switch models', () => {
    const { route, notices, renders } = recordingHarness(undefined)

    route.runModelCommand('')

    expect(notices).toEqual(['this profile has no llm service, so models cannot be listed or switched'])
    expect(renders).toHaveLength(1)
  })

  it('says a profile with no llm service cannot read reasoning efforts', () => {
    const { route, notices, renders } = recordingHarness(undefined)

    route.openEffortPicker()

    expect(notices).toEqual(['this profile has no llm service, so reasoning efforts cannot be read'])
    expect(renders).toHaveLength(1)
  })
})

describe('model command text forms', () => {
  const listing = (models: readonly { id: string }[]): unknown => ({
    listProviders: () => [{ id: 'lab', name: 'Lab' }],
    listModels: async () => models,
  })

  const listings: [string, { id: string }[], string][] = [
    ['names every model the provider advertises', [{ id: 'a' }, { id: 'b' }], 'lab: a b'],
    ['says an id may still work when the provider advertises none', [], 'lab advertises no models; an id may still work'],
  ]

  it.each(listings)('lists a provider by name and %s', async (_name, models, expected) => {
    const { route, notices, renders } = recordingHarness(listing(models))

    route.runModelCommand('lab')
    await settle()

    expect(notices).toEqual([expected])
    expect(renders).toHaveLength(1)
  })

  it('refuses a bare model id when the session has no route in use', () => {
    const { route, notices, renders } = recordingHarness(llmWith(NO_LEVELS))

    // A reader switching between two models of one provider should not have to
    // repeat it, but with no route in use there is no provider to read the id in.
    route.runModelCommand('mystery')

    expect(notices).toEqual(['/model: no route in use; say /model <provider>/mystery — providers: lab'])
    expect(renders).toHaveLength(1)
  })

  it('puts an explicitly requested level in force when the route offers it', async () => {
    const { route, notices } = recordingHarness(llmWith(LEVELS_WITH_MAX))

    route.runModelCommand('lab/m/high')
    await settle()

    expect(route.current()).toEqual({ provider: 'lab', model: 'm', reasoningEffort: 'high' })
    expect(notices).toEqual(['model set to lab/m (high) for the next step'])
  })

  const refusals: [string, () => Promise<unknown>, string][] = [
    ['names the levels it does offer', async () => efforts('low', 'high'), '/model: lab/m does not offer reasoning effort "max" — offers: low high'],
    ['says the route advertises none', NO_LEVELS, '/model: lab/m advertises no reasoning efforts'],
    ['reports a failure to read the levels', () => {
      throw new Error('boom')
    }, '/model: could not read reasoning efforts: boom'],
  ]

  it.each(refusals)('refuses an explicitly requested level and %s', async (_name, resolveModelInfo, expected) => {
    const { route, notices, renders } = recordingHarness(llmWith(resolveModelInfo))

    route.runModelCommand('lab/m/max')
    await settle()

    expect(notices).toEqual([expected])
    expect(route.current()).toBeUndefined()
    expect(renders).toHaveLength(1)
  })
})

describe('model picker discovery', () => {
  it('offers a rowless list for a provider advertising no models and refuses an id it never minted', async () => {
    const { route, notices, renders, openPicker } = recordingHarness(llmWith(LEVELS_WITH_MAX))
    openPicker.mockResolvedValueOnce('not-a-route-key')

    route.runModelCommand('')
    await settle()

    expect(openPicker).toHaveBeenCalledTimes(1)
    expect(openPicker.mock.calls[0]![0].card().rows).toEqual([])
    expect(route.current()).toBeUndefined()
    expect(notices).toEqual([])
    expect(renders).toHaveLength(1)
  })

  it('answers a second command from behind the picker the first one already opened', async () => {
    const { route, notices, openPicker } = recordingHarness(llmWith(LEVELS_WITH_MAX))
    let pick!: (id: string | undefined) => void
    openPicker.mockImplementationOnce(() => new Promise(resolve => {
      pick = resolve
    }))

    route.runModelCommand('')
    await settle()
    route.runModelCommand('')
    await settle()
    expect(openPicker).toHaveBeenCalledTimes(1)
    expect(notices).toEqual([])

    // Once the list is settled the keyboard is free for the next command.
    pick(undefined)
    await settle()
    route.runModelCommand('')
    await settle()
    expect(openPicker).toHaveBeenCalledTimes(2)
  })

  it('reads the picked route levels and applies the level the reader chose', async () => {
    const { route, notices, openPicker } = recordingHarness(llmWith(LEVELS_WITH_MAX))
    openPicker.mockResolvedValueOnce(modelRouteKey({ provider: 'lab', model: 'm' }))
    openPicker.mockResolvedValueOnce('high')

    route.runModelCommand('')
    await settle()
    await settle()

    // The second picker is the route's own levels, so the rows it would draw are
    // the contract between the catalogue and the reader.
    expect(openPicker.mock.calls[1]![0].card().rows.map(row => row.label)).toEqual([
      'provider default',
      'low',
      'high',
      'max',
    ])
    expect(route.current()).toEqual({ provider: 'lab', model: 'm', reasoningEffort: 'high' })
    expect(notices).toEqual([
      'model set to lab/m for the next step',
      'reasoning effort for lab/m set to high for the next step',
    ])
  })

  it('keeps the model that was already switched when its levels cannot be read', async () => {
    let reads = 0
    const resolveModelInfo = async (): Promise<unknown> => {
      reads += 1
      if (reads === 1) return efforts('low', 'max')
      throw new Error('adapter is down')
    }
    const { route, notices, openPicker } = recordingHarness(llmWith(resolveModelInfo), {
      statusFacts: () => ({ provider: 'lab', model: 'old', effort: 'max' }),
    })
    route.adoptDefault()
    openPicker.mockResolvedValueOnce(modelRouteKey({ provider: 'lab', model: 'm' }))

    route.runModelCommand('')
    await settle()
    await settle()

    // The directory is advisory when the route is switched by the reader: the
    // switch lands and the failed level list is a notice, not a refusal.
    expect(route.current()).toEqual({ provider: 'lab', model: 'm', reasoningEffort: 'max' })
    expect(notices).toEqual([
      'model set to lab/m for the next step',
      'could not read reasoning efforts: adapter is down',
    ])
  })
})

describe('reasoning effort picker', () => {
  it('asks for a model first when no route is in use', () => {
    const { route, notices, renders, openPicker } = recordingHarness(llmWith(LEVELS_WITH_MAX))

    route.openEffortPicker()

    expect(notices).toEqual(['no model route is in use; /model <provider>/<model> picks one first'])
    expect(renders).toHaveLength(1)
    expect(openPicker).not.toHaveBeenCalled()
  })

  it('says a route advertises no levels instead of opening an empty list', async () => {
    const { route, notices, openPicker } = recordingHarness(llmWith(NO_LEVELS), {
      statusFacts: () => ({ provider: 'lab', model: 'm' }),
    })

    route.openEffortPicker()
    await settle()

    expect(notices).toEqual(['lab/m advertises no reasoning efforts'])
    expect(openPicker).not.toHaveBeenCalled()
  })

  it('reports a failure to read the levels', async () => {
    const { route, notices, renders } = recordingHarness(llmWith(async () => {
      throw new Error('boom')
    }), { statusFacts: () => ({ provider: 'lab', model: 'm' }) })

    route.openEffortPicker()
    await settle()

    expect(notices).toEqual(['could not read reasoning efforts: boom'])
    expect(renders).toHaveLength(1)
  })

  const levels: [string, string, Record<string, string>, string][] = [
    ['an advertised level', 'high', { provider: 'lab', model: 'm', reasoningEffort: 'high' }, 'reasoning effort for lab/m set to high for the next step'],
    ['the provider default', PROVIDER_DEFAULT_EFFORT_ID, { provider: 'lab', model: 'm' }, 'reasoning effort for lab/m set to provider default for the next step'],
  ]

  it.each(levels)('puts %s in force for the next step', async (_name, picked, expectedRoute, expectedNotice) => {
    const { route, notices, openPicker } = recordingHarness(llmWith(LEVELS_WITH_MAX), {
      statusFacts: () => ({ provider: 'lab', model: 'm' }),
    })
    openPicker.mockResolvedValueOnce(picked)

    route.openEffortPicker()
    await settle()

    expect(openPicker.mock.calls[0]![0].card().rows.map(row => row.label)).toEqual([
      'provider default',
      'low',
      'high',
      'max',
    ])
    expect(route.current()).toEqual(expectedRoute)
    expect(notices).toEqual([expectedNotice])
  })

  it('reads one route levels for one key only', async () => {
    let resolveInfo!: (info: unknown) => void
    const resolveModelInfo = vi.fn(() => new Promise<unknown>(resolve => {
      resolveInfo = resolve
    }))
    const { route, notices, openPicker } = recordingHarness(llmWith(resolveModelInfo), {
      statusFacts: () => ({ provider: 'lab', model: 'm' }),
    })

    route.openEffortPicker()
    route.openEffortPicker()
    expect(resolveModelInfo).toHaveBeenCalledTimes(1)

    resolveInfo(efforts('high'))
    await settle()

    // Cancelling keeps the provider default: the reader stays on a real route.
    expect(notices).toEqual([])
    expect(openPicker).toHaveBeenCalledTimes(1)
  })
})

describe('agent scope', () => {
  it('composes the choice into the agent so the next assemble carries the route', async () => {
    type Assembled = { readonly variables: Record<string, string> }
    type Assemble = (assembly: unknown, context: unknown, next: () => Promise<Assembled>) => Promise<Assembled>
    const handlers = new Map<string, unknown>()
    const agentCtx = {
      on: (event: string, handler: unknown) => {
        handlers.set(event, handler)
        return () => {}
      },
    } as unknown as Context
    const { route } = recordingHarness(llmWith(LEVELS_WITH_MAX))

    route.setup(agentCtx)
    route.runModelCommand('lab/m')
    await settle()

    const assemble = handlers.get('system-prompt/assemble') as Assemble
    const assembled = await assemble({}, undefined, async () => ({ variables: {} }))
    expect(assembled.variables).toEqual({ provider: 'lab', model: 'm' })
  })
})

describe('deployment default', () => {
  it('adopts nothing without a route and never overwrites the reader', async () => {
    let status: Partial<StatusFacts> = {}
    const { route } = recordingHarness(llmWith(LEVELS_WITH_MAX), { statusFacts: () => status })

    route.adoptDefault()
    expect(route.current()).toBeUndefined()

    route.runModelCommand('lab/m')
    await settle()
    status = { provider: 'default-lab', model: 'default-model', effort: 'max' }
    route.adoptDefault()
    expect(route.current()).toEqual({ provider: 'lab', model: 'm' })
  })
})

