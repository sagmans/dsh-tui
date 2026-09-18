import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_PRESET_KEY,
  createPresetRoster,
  describePreset,
  parsePresetArgument,
  type PresetSummary,
} from '@/agent/presets.ts'

/** A context offering only the services a case composes. */
function fakeContext(services: Record<string, unknown>): Context {
  return { get: (name: string) => services[name] } as unknown as Context
}

/** One roster row, with the fields a case does not care about left unset. */
function summary(overrides: Partial<PresetSummary> = {}): PresetSummary {
  return { id: 'standard', trust: 'system', name: undefined, description: undefined, broken: undefined, ...overrides }
}

/** The roster service as the harness publishes it, reduced to what the surface reads. */
function rosterService(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    defaultId: 'standard',
    list: vi.fn(async () => [{ id: 'standard', trust: 'system' }, { id: 'ptc', trust: 'system', name: 'PTC' }, { nope: true }]),
    resolve: vi.fn(async (id?: string) => ({ id: id ?? 'standard', trust: 'system' })),
    mount: vi.fn(async () => ({ id: 'standard' })),
    select: vi.fn(async (_agent: unknown, id: string) => id),
    ...overrides,
  }
}

describe('parsePresetArgument', () => {
  it('asks for the picker on a bare command and names an id otherwise', () => {
    expect(parsePresetArgument('')).toEqual({ kind: 'pick' })
    expect(parsePresetArgument('   ')).toEqual({ kind: 'pick' })
    expect(parsePresetArgument('  ptc ')).toEqual({ kind: 'switch', id: 'ptc' })
  })
})

describe('describePreset', () => {
  it('marks the running mode and glosses a shipped one', () => {
    const row = describePreset(summary(), 'standard')
    expect(row.label).toBe('standard')
    expect(row.current).toBe(true)
    expect(row.description).toContain('full agent')
  })

  it('lets a preset this deployment does not ship describe itself', () => {
    const row = describePreset(
      summary({ id: 'mine', name: 'Mine', description: 'my composition', trust: 'user' }),
      undefined,
    )
    expect(row.current).toBe(false)
    expect(row.description).toBe('Mine · my composition · authored here')
  })

  it('says why a preset cannot start instead of how it reads', () => {
    const row = describePreset(summary({ id: 'broken-one', broken: 'composition file is unreadable' }), undefined)
    expect(row.description).toBe('cannot start: composition file is unreadable')
  })

  it('carries no description when the preset published none and is unknown here', () => {
    expect(describePreset(summary({ id: 'silent' }), undefined).description).toBeUndefined()
  })
})

describe('createPresetRoster', () => {
  it('is absent when the composition mounts no roster', () => {
    expect(createPresetRoster(fakeContext({}))).toBeUndefined()
  })

  it('is absent when the roster cannot name a default', () => {
    expect(createPresetRoster(fakeContext({ agentPresets: rosterService({ defaultId: undefined }) }))).toBeUndefined()
  })

  it('reads the roster and drops rows that name no id', async () => {
    const roster = createPresetRoster(fakeContext({ agentPresets: rosterService() }))
    expect(roster?.defaultId).toBe('standard')
    expect((await roster?.list())?.map(preset => preset.id)).toEqual(['standard', 'ptc'])
  })

  it('reads the default per call, so a settings change reaches the next session', () => {
    const service = rosterService()
    const roster = createPresetRoster(fakeContext({ agentPresets: service }))
    expect(roster?.defaultId).toBe('standard')
    service.defaultId = 'ptc'
    expect(roster?.defaultId).toBe('ptc')
    // A service that momentarily answers nothing keeps the id it named first.
    service.defaultId = undefined
    expect(roster?.defaultId).toBe('standard')
  })

  it('refuses a resolve that answered nothing usable', async () => {
    const roster = createPresetRoster(fakeContext({ agentPresets: rosterService({ resolve: vi.fn(async () => undefined) }) }))
    await expect(roster?.resolve('ptc')).rejects.toThrow('resolved')
  })

  it('refuses to switch a session on a roster that cannot', async () => {
    const roster = createPresetRoster(fakeContext({ agentPresets: rosterService({ select: undefined }) }))
    await expect(roster?.select({}, 'ptc')).rejects.toThrow('cannot switch')
  })

  it('reads the running mode from the projection the roster advances', () => {
    const stateOf = vi.fn((_session: unknown, key: string) => (key === AGENT_PRESET_KEY ? 'ptc' : null))
    const roster = createPresetRoster(fakeContext({ agentPresets: rosterService(), sessionProjections: { stateOf } }))
    expect(roster?.current({})).toBe('ptc')
  })

  it('treats a session as fixed once it has an open or a completed turn', () => {
    const roster = (stateOf: (session: unknown, key: string) => unknown) =>
      createPresetRoster(fakeContext({ agentPresets: rosterService(), sessionProjections: { stateOf } }))
    expect(roster(() => ({ openTurnStartSeq: null, lastTurn: 0 }))?.started({})).toBe(false)
    expect(roster(() => ({ openTurnStartSeq: 3, lastTurn: 1 }))?.started({})).toBe(true)
    expect(roster(() => ({ openTurnStartSeq: null, lastTurn: 2 }))?.started({})).toBe(true)
    // A composition with no projection registry cannot say, so it stays blank.
    expect(roster(() => undefined)?.started({})).toBe(false)
    expect(createPresetRoster(fakeContext({ agentPresets: rosterService() }))?.started({})).toBe(false)
  })

  it('survives a projection registry that throws for an unregistered key', () => {
    const stateOf = (): unknown => { throw new Error('no such projection') }
    const roster = createPresetRoster(fakeContext({ agentPresets: rosterService(), sessionProjections: { stateOf } }))
    expect(roster?.current({})).toBeUndefined()
    expect(roster?.started({})).toBe(false)
  })

  it('mounts the named preset through the roster', async () => {
    const agentPresets = rosterService()
    const roster = createPresetRoster(fakeContext({ agentPresets }))
    await roster?.mount({} as Context, 'ptc')
    expect(agentPresets.mount).toHaveBeenCalledWith({}, 'ptc')
  })
})
