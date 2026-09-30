import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createKeymapRegistry, type PluginAction, type ActionPorts } from '@/keymaps.ts'
import { resolveKeymap, keysFor, surfaceBindings } from '@/input/actions.ts'
import { chordBindings } from '@/input/keymap.ts'

const ID = 'plugin.example.choice'
const KEY = 't'
const REMAPPED_KEY = 'v'
const ports: ActionPorts = { route: { provider: 'example', model: 'model' }, pick: async () => undefined, notice: () => {} }

/** Use real Cordis owners so disposal tests prove the public lifecycle contract. */
async function install(registry: ReturnType<typeof createKeymapRegistry>, action: PluginAction) {
  const ctx = new Context()
  return await ctx.plugin((owner: Context) => { registry.register(owner, action) })
}

describe('plugin-owned keymaps', () => {
  it('registers a chord outside the builtin catalog and honors rebinding', async () => {
    const registry = createKeymapRegistry()
    let calls = 0
    const owner = await install(registry, { id: ID, layer: 'chord', defaultKeys: [KEY], label: 'example choice', handler: async () => { calls++ } })
    try {
      const map = resolveKeymap({ [ID]: REMAPPED_KEY }, registry.catalog())
      expect(keysFor(map, ID)).toEqual([REMAPPED_KEY])
      expect(chordBindings(map).find(row => row.key === REMAPPED_KEY)?.submission).toEqual({ kind: 'plugin-action', id: ID })
      await registry.dispatch(ID, ports)
      expect(calls).toBe(1)
      expect(createKeymapRegistry().catalog().some(row => row.id === ID)).toBe(false)
    } finally { await owner.dispose() }
  })

  it('removes handlers and metadata with their owner, retaining dormant preferences', async () => {
    const registry = createKeymapRegistry()
    const owner = await install(registry, { id: ID, layer: 'chord', defaultKeys: [KEY], label: 'example choice', handler: async () => {} })
    await owner.dispose()
    expect(registry.catalog().some(row => row.id === ID)).toBe(false)
    const dormant = resolveKeymap({ [ID]: REMAPPED_KEY }, registry.catalog())
    expect(chordBindings(dormant).some(row => row.submission.kind === 'plugin-action')).toBe(false)
    expect(dormant.written.has(ID)).toBe(true)
    await expect(registry.dispatch(ID, ports)).rejects.toThrow('plugin key action is unavailable')
  })

  it('rejects duplicate identities and conflicting keys without replacing the active registration', async () => {
    const registry = createKeymapRegistry()
    const ctx = new Context()
    const original = await install(registry, { id: ID, layer: 'chord', defaultKeys: [KEY], label: 'original', handler: async () => {} })
    try {
      expect(() => registry.register(ctx, { id: ID, layer: 'chord', defaultKeys: [REMAPPED_KEY], label: 'duplicate', handler: async () => {} })).toThrow('duplicate plugin key action')
      expect(() => registry.register(ctx, { id: 'plugin.other.choice', layer: 'chord', defaultKeys: ['m'], label: 'conflict', handler: async () => {} })).toThrow()
      expect(registry.catalog().find(row => row.id === ID)?.label).toBe('original')
      expect(registry.catalog().some(row => row.id === 'plugin.other.choice')).toBe(false)
    } finally { await original.dispose() }
  })

  it('validates late registrations against live preferences before publishing them', async () => {
    const registry = createKeymapRegistry()
    const preferences = { [ID]: 'm' }
    const stop = registry.observe(catalog => { resolveKeymap(preferences, catalog) }, () => {})
    try {
      expect(() => registry.register(new Context(), { id: ID, layer: 'chord', defaultKeys: [KEY], label: 'choice', handler: async () => {} })).toThrow()
      expect(registry.catalog().some(row => row.id === ID)).toBe(false)
    } finally { stop() }
  })

  it('runs generic effort follow-ups only while their owner is mounted', async () => {
    const registry = createKeymapRegistry()
    let calls = 0
    const ctx = new Context()
    const owner = await ctx.plugin((scoped: Context) => { registry.afterEffort(scoped, async () => { calls++ }) })
    await registry.effortConfirmed(ports)
    await owner.dispose()
    await registry.effortConfirmed(ports)
    expect(calls).toBe(1)
  })
})
const SURFACE_KEY = 'ctrl+alt+b'

it('routes modifier surface bindings through generic plugin submissions', async () => {
  const registry = createKeymapRegistry()
  const owner = await install(registry, { id: ID, layer: 'surface', defaultKeys: [SURFACE_KEY], label: 'surface action', handler: async () => {} })
  try {
    const map = resolveKeymap({}, registry.catalog())
    expect(surfaceBindings(map).find(row => row.id === ID)).toEqual({ id: ID, action: 'plugin', key: SURFACE_KEY })
  } finally { await owner.dispose() }
})

it('rejects prose-stealing defaults, invalid keys, and viewport-owned presses', () => {
  const registry = createKeymapRegistry()
  const owner = new Context()
  for (const key of ['q', 'not-a-key', 'pageup']) {
    expect(() => registry.register(owner, { id: ID, layer: 'surface', defaultKeys: [key as typeof SURFACE_KEY], label: 'invalid', handler: async () => {} })).toThrow()
  }
  expect(registry.catalog().some(row => row.id === ID)).toBe(false)
})
it('keeps a shared effort handler until every registering owner releases it', async () => {
  const registry = createKeymapRegistry()
  const ctx = new Context()
  let calls = 0
  const handler = async () => { calls++ }
  const first = await ctx.plugin((owner: Context) => { registry.afterEffort(owner, handler) })
  const second = await ctx.plugin((owner: Context) => { registry.afterEffort(owner, handler) })
  try {
    await first.dispose()
    await registry.effortConfirmed(ports)
    expect(calls).toBe(1)
  } finally { await first.dispose(); await second.dispose() }
})
