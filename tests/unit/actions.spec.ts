import { TUI_KEYBINDINGS, type KeyId } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import {
  ACTION_CATALOG,
  KEYMAP_ALIASES,
  defaultKeymap,
  keysFor,
  newShadows,
  normalizeKey,
  resolveKeymap,
  shadowsOf,
  type Action,
} from '@/input/actions.ts'

/** The keys every action the surface owns ships with, spelled as the reader writes them. */
const SHIPPED: Readonly<Record<string, readonly string[]>> = {
  'prompt.submit': ['ctrl+enter', 'alt+enter', 'ctrl+s'],
  'prompt.newLine': ['enter', 'shift+enter', 'ctrl+j'],
  'surface.toolDetail': ['ctrl+o'],
  'surface.subCalls': ['ctrl+y'],
  'surface.reasoning': ['shift+tab'],
  'surface.effort': ['ctrl+t'],
  'surface.back': ['ctrl+b'],
  'surface.interrupt': ['ctrl+c'],
  'chord.prefix': ['ctrl+x'],
  'chord.model': ['m'],
  'chord.plan': ['p'],
  'chord.copy': ['y'],
  'gate.allow': ['y'],
  'gate.reject': ['n'],
  'gate.cancel': ['escape'],
  'question.up': ['up'],
  'question.down': ['down'],
  'question.toggle': ['space'],
  'question.confirm': ['enter'],
  'question.skip': ['escape'],
  'picker.up': ['up'],
  'picker.down': ['down'],
  'picker.confirm': ['enter'],
  'picker.cancel': ['escape', 'ctrl+c'],
}

function action(id: string): Action {
  const found = ACTION_CATALOG.find(entry => entry.id === id)
  if (found === undefined) throw new Error(`no action ${id}`)
  return found
}

describe('the action catalog', () => {
  it('names every action once', () => {
    const ids = ACTION_CATALOG.map(entry => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(Object.keys(SHIPPED).every(id => ids.includes(id))).toBe(true)
  })

  it('ships exactly the keys the surface answers today', () => {
    for (const [id, keys] of Object.entries(SHIPPED)) {
      expect(action(id).defaultKeys, id).toEqual(keys)
    }
  })

  it('keeps every action bindable or says why it is not', () => {
    for (const entry of ACTION_CATALOG) {
      expect(entry.label.length, entry.id).toBeGreaterThan(0)
      expect(entry.defaultKeys.length > 0 || entry.mayUnbind, entry.id).toBe(true)
    }
  })

  it('lets a bare character be bound only where the reader does not type', () => {
    expect(action('chord.model').mayUseBare).toBe(true)
    expect(action('gate.allow').mayUseBare).toBe(true)
    for (const id of ['prompt.submit', 'prompt.newLine', 'surface.effort', 'question.up', 'picker.up']) {
      expect(action(id).mayUseBare, id).toBe(false)
    }
  })

  it('lets only a key the library ships unbound be emptied', () => {
    expect(action('tui.editor.historyPrevious').mayUnbind).toBe(true)
    expect(action('tui.editor.yank').mayUnbind).toBe(false)
    expect(action('prompt.submit').mayUnbind).toBe(false)
  })

  it('takes the library rows from the library own table', () => {
    const aliased = Object.keys(KEYMAP_ALIASES)
    const library = ACTION_CATALOG.filter(entry => entry.layer === 'library').map(entry => entry.id).sort()
    const expected = Object.keys(TUI_KEYBINDINGS).filter(id => !aliased.includes(id)).sort()
    expect(library).toEqual(expected)
    for (const id of library) {
      const definition = TUI_KEYBINDINGS[id as keyof typeof TUI_KEYBINDINGS]
      expect(action(id).label, id).toBe(definition.description)
      const defaults = Array.isArray(definition.defaultKeys) ? definition.defaultKeys : [definition.defaultKeys]
      expect(action(id).defaultKeys, id).toEqual(defaults.map(key => normalizeKey(key)))
    }
  })

  it('refuses the two library spellings whose meaning the prompt bar owns', () => {
    expect(KEYMAP_ALIASES['tui.input.submit']).toBe('prompt.submit')
    expect(KEYMAP_ALIASES['tui.input.newLine']).toBe('prompt.newLine')
  })
})

describe('normalizeKey', () => {
  it('takes a named key in any case and returns the library own spelling', () => {
    expect(normalizeKey('enter')).toBe('enter')
    expect(normalizeKey('pageUp')).toBe('pageUp')
    expect(normalizeKey('pageup')).toBe('pageUp')
  })

  it('folds the library synonyms so two spellings cannot claim one key', () => {
    expect(normalizeKey('esc')).toBe('escape')
    expect(normalizeKey('return')).toBe('enter')
  })

  it('orders and lowercases the modifiers', () => {
    expect(normalizeKey('Shift+Ctrl+P')).toBe('ctrl+shift+p')
    expect(normalizeKey('alt+ctrl+x')).toBe('ctrl+alt+x')
    expect(normalizeKey('super+Alt+Shift+Ctrl+k')).toBe('ctrl+shift+alt+super+k')
  })

  it('takes symbols, digits, and function keys', () => {
    expect(normalizeKey('ctrl+]')).toBe('ctrl+]')
    expect(normalizeKey('f5')).toBe('f5')
    expect(normalizeKey('ctrl+1')).toBe('ctrl+1')
  })

  it('refuses what the terminal cannot report as one press', () => {
    expect(normalizeKey('ctrl+')).toBeUndefined()
    expect(normalizeKey('ctrl+ctrl+x')).toBeUndefined()
    expect(normalizeKey('meta+x')).toBeUndefined()
    expect(normalizeKey('nope')).toBeUndefined()
    expect(normalizeKey('')).toBeUndefined()
    expect(normalizeKey('ctrl+shift')).toBeUndefined()
  })
})

describe('resolveKeymap', () => {
  it('keeps every default when the reader writes nothing', () => {
    const map = resolveKeymap({})
    expect(keysFor(map, 'prompt.submit')).toEqual(['ctrl+enter', 'alt+enter', 'ctrl+s'])
    expect(map.written.size).toBe(0)
    expect(Object.keys(map.effective).length).toBe(ACTION_CATALOG.length)
  })

  it('merges the actions the reader did write and leaves the rest alone', () => {
    const map = resolveKeymap({ 'surface.effort': 'ctrl+e' })
    expect(keysFor(map, 'surface.effort')).toEqual(['ctrl+e'])
    expect(keysFor(map, 'surface.toolDetail')).toEqual(['ctrl+o'])
    expect([...map.written]).toEqual(['surface.effort'])
  })

  it('takes one key or a list of them, and drops a repeat inside one list', () => {
    expect(keysFor(resolveKeymap({ 'prompt.submit': 'ctrl+g' }), 'prompt.submit')).toEqual(['ctrl+g'])
    expect(keysFor(resolveKeymap({ 'prompt.submit': ['ctrl+g', 'ctrl+g'] }), 'prompt.submit')).toEqual(['ctrl+g'])
  })

  it('refuses an action the surface does not have, naming it', () => {
    expect(() => resolveKeymap({ 'surface.nope': 'ctrl+g' })).toThrow(/surface.nope/)
  })

  it('refuses a library spelling it does not own, pointing at the one it does', () => {
    expect(() => resolveKeymap({ 'tui.input.submit': 'ctrl+g' })).toThrow(/prompt.submit/)
    expect(() => resolveKeymap({ 'tui.input.newLine': 'ctrl+j' })).toThrow(/prompt.newLine/)
  })

  it('refuses a key the tty keeps for itself', () => {
    expect(() => resolveKeymap({ 'surface.effort': 'ctrl+q' })).toThrow(/terminal/)
  })

  it('refuses a bare character where the reader types', () => {
    expect(() => resolveKeymap({ 'surface.effort': 'e' })).toThrow(/surface.effort/)
    expect(() => resolveKeymap({ 'question.up': 'k' })).toThrow(/question.up/)
    expect(() => resolveKeymap({ 'picker.up': 'k' })).toThrow(/picker.up/)
    expect(() => resolveKeymap({ 'tui.editor.yank': 'v' })).toThrow(/tui.editor.yank/)
    expect(() => resolveKeymap({ 'prompt.submit': ' ' })).toThrow(/prompt.submit/)
  })

  it('takes a bare character for the approval gate and the chord, which are theirs while armed', () => {
    expect(keysFor(resolveKeymap({ 'gate.allow': 'a' }), 'gate.allow')).toEqual(['a'])
    expect(keysFor(resolveKeymap({ 'chord.model': 'n' }), 'chord.model')).toEqual(['n'])
  })

  it('refuses a key it cannot parse, naming the action', () => {
    expect(() => resolveKeymap({ 'surface.effort': 'ctrl+' })).toThrow(/surface.effort/)
    expect(() => resolveKeymap({ 'surface.effort': 'meta+x' })).toThrow(/surface.effort/)
  })

  it('refuses to empty an action the surface needs', () => {
    expect(() => resolveKeymap({ 'prompt.submit': [] })).toThrow(/prompt.submit/)
    expect(() => resolveKeymap({ 'surface.effort': [] })).toThrow(/surface.effort/)
  })

  it('takes an empty list for an action the library ships unbound', () => {
    expect(keysFor(resolveKeymap({ 'tui.editor.historyPrevious': [] }), 'tui.editor.historyPrevious')).toEqual([])
    expect(keysFor(resolveKeymap({ 'tui.editor.historyPrevious': 'alt+p' }), 'tui.editor.historyPrevious')).toEqual(['alt+p'])
  })

  it('refuses two actions of one layer claiming one key', () => {
    expect(() => resolveKeymap({ 'surface.effort': 'ctrl+o' })).toThrow(/surface.toolDetail/)
    expect(() => resolveKeymap({ 'gate.reject': 'y' })).toThrow(/gate.allow/)
    expect(() => resolveKeymap({ 'prompt.submit': ['ctrl+g'], 'prompt.newLine': ['ctrl+g'] })).toThrow(/prompt\.submit/)
  })

  it('lets two layers share a key, which is how the shipped map already works', () => {
    expect(keysFor(resolveKeymap({}), 'surface.subCalls')).toEqual(['ctrl+y'])
    expect(keysFor(resolveKeymap({}), 'tui.editor.yank')).toEqual(['ctrl+y'])
    expect(() => resolveKeymap({ 'surface.subCalls': 'ctrl+y' })).not.toThrow()
  })

  it('refuses two library actions the reader gave one key', () => {
    expect(() => resolveKeymap({ 'tui.editor.yank': 'ctrl+g', 'tui.input.copy': 'ctrl+g' })).toThrow(/tui\.input\.copy|tui\.editor\.yank/)
  })

  it('refuses a chord starter that is not a modifier chord', () => {
    expect(() => resolveKeymap({ 'chord.prefix': 'x' })).toThrow(/modifier chord/)
    expect(() => resolveKeymap({ 'chord.prefix': 'up' })).toThrow(/modifier chord/)
    expect(() => resolveKeymap({ 'chord.prefix': 'ctrl+shift+up' })).toThrow(/modifier chord/)
    expect(keysFor(resolveKeymap({ 'chord.prefix': 'alt+z' }), 'chord.prefix')).toEqual(['alt+z'])
  })

  it('refuses a chord starter that would take a key the surface answers', () => {
    expect(() => resolveKeymap({ 'chord.prefix': 'ctrl+y' })).toThrow(/surface\.subCalls/)
    expect(() => resolveKeymap({ 'chord.prefix': 'ctrl+s' })).toThrow(/prompt\.submit/)
  })
})

describe('shadows', () => {
  it('reports the surface keys that take a library action own key', () => {
    const found = shadowsOf(defaultKeymap())
    const yank = found.find(entry => entry.loser === 'tui.editor.yank')
    expect(yank?.winner).toBe('surface.subCalls')
    expect(yank?.key).toBeDefined()
  })

  it('reports a shadow the reader just introduced, and nothing they did not', () => {
    const fresh = newShadows(resolveKeymap({ 'surface.effort': 'ctrl+e' }))
    expect(fresh).toContainEqual({ key: 'ctrl+e', winner: 'surface.effort', loser: 'tui.editor.cursorLineEnd' })
    expect(newShadows(defaultKeymap())).toEqual([])
  })

  it('says nothing about keys two library actions share by design', () => {
    const found = shadowsOf(defaultKeymap())
    expect(found.some(entry => entry.winner.startsWith('tui.') && entry.loser.startsWith('tui.'))).toBe(false)
  })
})

describe('keysFor', () => {
  it('answers an action the map does not know with nothing rather than throwing', () => {
    expect(keysFor(defaultKeymap(), 'nope.id')).toEqual([])
  })
})

describe('the key id type', () => {
  it('keeps the catalog honest about the ids it hands the library', () => {
    const typed: KeyId = keysFor(defaultKeymap(), 'surface.effort')[0] ?? 'ctrl+t'
    expect(typed).toBe('ctrl+t')
  })
})
