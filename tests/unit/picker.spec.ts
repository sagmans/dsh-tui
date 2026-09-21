import { describe, expect, it } from 'vitest'
import { defaultKeymap, resolveKeymap, type Keymap } from '@/input/actions.ts'
import type { StoredSession } from '@/agent/history.ts'
import { modelRouteKey, type ModelChoice, type ModelRoute } from '@/agent/model.ts'
import type { PresetSummary } from '@/agent/presets.ts'
import { PICKER_WINDOW, EffortPicker, ModelPicker, PresetPicker, SessionPicker, describeAge, effortChoices, type EffortChoice } from '@/ui/picker.ts'

const session = (id: string, overrides: Partial<StoredSession> = {}): StoredSession => ({
  id,
  cwd: '/work',
  createdAt: 1_000_000,
  eventCount: 12,
  ...overrides,
})

const pickerOf = (sessions: StoredSession[], titles: Record<string, string> = {}, keys: () => Keymap = defaultKeymap): SessionPicker =>
  new SessionPicker(sessions, () => new Map(Object.entries(titles)), () => 1_000_000, keys)

describe('describeAge', () => {
  it('reads as a moment rather than a timestamp', () => {
    expect(describeAge(1_000_000, 1_000_000)).toBe('just now')
    expect(describeAge(0, 5 * 60_000)).toBe('5m ago')
    expect(describeAge(0, 3 * 3_600_000)).toBe('3h ago')
    expect(describeAge(0, 2 * 86_400_000)).toBe('2d ago')
  })
})

describe('SessionPicker', () => {
  it('picks the highlighted session on enter', () => {
    const picker = pickerOf([session('a'), session('b')])
    expect(picker.handleKey('\u001b[B')).toBeUndefined()
    expect(picker.handleKey('\r')).toEqual({ kind: 'pick', id: 'b' })
  })

  it('cancels on escape', () => {
    expect(pickerOf([session('a')]).handleKey('\u001b')).toEqual({ kind: 'cancel' })
  })

  it('cancels on the interrupt key too, rather than swallowing it', () => {
    expect(pickerOf([session('a')]).handleKey('\u0003')).toEqual({ kind: 'cancel' })
  })

  it('picks, cancels, and moves on the keys the reader chose', () => {
    const map = resolveKeymap({ 'picker.confirm': 'alt+y', 'picker.cancel': 'alt+g', 'picker.down': 'alt+d', 'picker.up': 'alt+u' })
    const picker = pickerOf([session('a'), session('b')], {}, () => map)
    expect(picker.card().hint).toBe('alt+u or alt+d move · alt+y open · alt+g cancel · type to filter')
    expect(picker.handleKey('\r')).toBeUndefined()
    expect(picker.handleKey('\u001b[B')).toBeUndefined()
    expect(picker.card().rows[0]?.current).toBe(true)
    expect(picker.handleKey('\u001bd')).toBeUndefined()
    expect(picker.card().rows[1]?.current).toBe(true)
    expect(picker.handleKey('\u001bg')).toEqual({ kind: 'cancel' })
    expect(picker.handleKey('\u001by')).toEqual({ kind: 'pick', id: 'b' })
  })

  it('filters by title, id, and directory', () => {
    const picker = pickerOf([session('a', { cwd: '/one' }), session('b', { cwd: '/two' })], { a: 'fix the parser' })
    picker.handleKey('p')
    picker.handleKey('a')
    expect(picker.visible().map(entry => entry.id)).toEqual(['a'])
    picker.handleKey('\u007f')
    picker.handleKey('\u007f')
    picker.handleKey('t')
    picker.handleKey('w')
    picker.handleKey('o')
    expect(picker.visible().map(entry => entry.id)).toEqual(['b'])
  })

  it('matches a fragment of a title whose letters are not contiguous', () => {
    const picker = pickerOf([session('a', { cwd: '/one' }), session('b', { cwd: '/two' })], { a: 'fix the parser' })
    for (const key of 'ftp') picker.handleKey(key)
    expect(picker.visible().map(entry => entry.id)).toEqual(['a'])
  })

  it('filters from a pasted run instead of dropping it', () => {
    const picker = pickerOf([session('a', { cwd: '/one' }), session('b', { cwd: '/two' })], { a: 'fix the parser' })
    expect(picker.handleKey('\u001b[200~parser\u001b[201~')).toBeUndefined()
    expect(picker.visible().map(entry => entry.id)).toEqual(['a'])
  })

  it('never highlights a row that does not exist', () => {
    const picker = pickerOf([session('a')])
    picker.handleKey('\u001b[B')
    picker.handleKey('\u001b[B')
    expect(picker.card().rows[0]?.current).toBe(true)
    expect(picker.handleKey('\r')).toEqual({ kind: 'pick', id: 'a' })
  })

  it('says how to widen an empty result instead of picking nothing', () => {
    const picker = pickerOf([session('a')])
    picker.handleKey('z')
    expect(picker.visible()).toEqual([])
    expect(picker.handleKey('\r')).toBeUndefined()
    expect(picker.card().hint).toContain('nothing matches')
  })

  it('keeps the cursor inside the window it draws', () => {
    const many = Array.from({ length: 40 }, (_, index) => session(`s${index}`))
    const picker = pickerOf(many)
    const first = picker.card()
    expect(first.rows).toHaveLength(PICKER_WINDOW)
    expect(first.rows[0]?.current).toBe(true)
    expect(first.above).toBe(0)
    expect(first.below).toBe(40 - PICKER_WINDOW)
    for (let step = 0; step < 30; step += 1) picker.handleKey('\u001b[B')
    const moved = picker.card()
    expect(moved.rows.some(row => row.current)).toBe(true)
    expect(moved.above).toBeGreaterThan(0)
    expect(moved.above + moved.rows.length + moved.below).toBe(40)
  })

  it('carries a refusal note until the reader does something else', () => {
    const picker = pickerOf([session('a'), session('b')])
    expect(picker.card().note).toBeUndefined()
    picker.setNote('session a runs mode "cordis", so --preset standard does not apply')
    expect(picker.card().note).toContain('does not apply')
    picker.handleKey('\u001b[B')
    expect(picker.card().note).toBeUndefined()
  })

  it('offers the newest session first and titles it when known', () => {
    const picker = pickerOf([session('new', { createdAt: 999_500 }), session('old', { createdAt: 1_000 })], { new: 'latest work' })
    const card = picker.card()
    expect(card.rows[0]?.label).toBe('latest work')
    expect(card.rows[0]?.description).toBe('/work · just now · 12 events')
    expect(card.title).toBe('resume a session · 2 stored')
  })
})

const PRESETS: readonly PresetSummary[] = [
  { id: 'standard', trust: 'system', name: 'Standard', description: 'every tool', broken: undefined },
  { id: 'minimal', trust: 'system', name: 'Minimal', description: 'read and search', broken: undefined },
]

describe('PresetPicker', () => {
  it('matches a fragment of a mode name and picks the row it left', () => {
    const picker = new PresetPicker(() => PRESETS, () => 'standard')
    for (const key of 'mnml') picker.handleKey(key)
    expect(picker.visible().map(preset => preset.id)).toEqual(['minimal'])
    expect(picker.handleKey('\r')).toEqual({ kind: 'pick', id: 'minimal' })
  })
})

const EFFORTS: readonly EffortChoice[] = [
  { id: '', name: 'provider default', description: 'clear the explicit effort', current: false },
  { id: 'low', name: 'Low', current: false },
  { id: 'high', name: 'High', description: 'thorough', current: true },
]

const effortPicker = (): EffortPicker =>
  new EffortPicker(() => EFFORTS, 'reasoning effort · kimi-coding/k2')

describe('EffortPicker', () => {
  it('picks the row under the cursor, including the provider default', () => {
    expect(effortPicker().handleKey('\r')).toEqual({ kind: 'pick', id: '' })
    const moved = effortPicker()
    moved.handleKey('\u001b[B')
    expect(moved.handleKey('\r')).toEqual({ kind: 'pick', id: 'low' })
  })

  it('names the effort in force and what the default row clears', () => {
    const rows = effortPicker().card().rows
    expect(rows.find(row => row.label === 'High')?.description).toContain('current')
    expect(rows.find(row => row.label === 'provider default')?.description).toContain('clear')
  })

  it('filters by effort name or id', () => {
    const picker = effortPicker()
    picker.handleKey('h')
    picker.handleKey('i')
    expect(picker.visible().map(choice => choice.id)).toEqual(['high'])
    const byDefault = effortPicker()
    byDefault.handleKey('d')
    expect(byDefault.visible().map(choice => choice.id)).toEqual([''])
  })
})

describe('effortChoices', () => {
  it('leads with the provider default and marks the effort in force', () => {
    expect(effortChoices([{ id: 'low', name: 'Low' }, { id: 'high', name: 'High', description: 'thorough' }], 'high')).toEqual([
      { id: '', name: 'provider default', description: 'clear the explicit effort', current: false },
      { id: 'low', name: 'Low', current: false },
      { id: 'high', name: 'High', description: 'thorough', current: true },
    ])
  })

  it('matches a fragment of an effort whose letters are not contiguous', () => {
    const picker = effortPicker()
    for (const key of 'hgh') picker.handleKey(key)
    expect(picker.visible().map(choice => choice.id)).toEqual(['high'])
  })

  it('marks the provider default when no effort is in force', () => {
    expect(effortChoices([{ id: 'low', name: 'Low' }], undefined)[0]?.current).toBe(true)
  })
})

const ROUTES: readonly ModelRoute[] = [
  { provider: 'kimi-coding', model: 'k2', name: 'K2' },
  { provider: 'zai-coding-cn', model: 'glm-5.3', name: 'GLM 5.3' },
]

const modelPicker = (
  routes: readonly ModelRoute[] = ROUTES,
  current: ModelChoice | undefined = { provider: 'kimi-coding', model: 'k2' },
): ModelPicker => new ModelPicker(() => routes, () => current)

describe('ModelPicker', () => {
  it('picks the highlighted route on enter', () => {
    const picker = modelPicker()
    expect(picker.handleKey('\u001b[B')).toBeUndefined()
    expect(picker.handleKey('\r')).toEqual({
      kind: 'pick',
      id: modelRouteKey({ provider: 'zai-coding-cn', model: 'glm-5.3' }),
    })
  })

  it('filters by provider, model id, and advertised name', () => {
    const byProvider = modelPicker()
    byProvider.handleKey('z')
    expect(byProvider.visible().map(route => route.model)).toEqual(['glm-5.3'])
    const byId = modelPicker()
    for (const key of 'glm-5') byId.handleKey(key)
    expect(byId.visible().map(route => route.provider)).toEqual(['zai-coding-cn'])
    const byName = modelPicker()
    byName.handleKey('K')
    byName.handleKey('2')
    expect(byName.visible().map(route => route.model)).toEqual(['k2'])
  })

  it('matches a fragment whose punctuation the reader left out, best match first', () => {
    const routes: readonly ModelRoute[] = [
      { provider: 'kimi-coding', model: 'g-l-m-5-3', name: 'Scattered' },
      { provider: 'zai-coding-cn', model: 'glm-5.3', name: 'GLM 5.3' },
    ]
    const picker = new ModelPicker(() => routes, () => undefined)
    for (const key of 'glm53') picker.handleKey(key)
    expect(picker.visible().map(route => route.model)).toEqual(['glm-5.3', 'g-l-m-5-3'])
  })

  it('shows rows that arrive after it opened, without reopening it', () => {
    const routes: ModelRoute[] = []
    const picker = new ModelPicker(() => routes, () => undefined)
    picker.handleKey('l')
    picker.handleKey('a')
    routes.push({ provider: 'kimi-coding', model: 'k2-latest', name: 'K2 Latest' })
    expect(picker.visible().map(route => route.model)).toEqual(['k2-latest'])
  })

  it('says the route in force and where an unadvertised id goes', () => {
    const card = modelPicker().card()
    expect(card.title).toContain('kimi-coding/k2')
    expect(card.rows.find(row => row.label === 'K2')?.description).toContain('current')
    expect(modelPicker([]).card().hint).toContain('/model')
  })
})
