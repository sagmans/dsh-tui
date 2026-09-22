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
  'surface.quit': ['ctrl+d'],
  'chord.prefix': ['ctrl+x'],
  'chord.model': ['m'],
  'chord.plan': ['p'],
  'chord.copy': ['y'],
  'chord.editor': ['e'],
  'gate.allow': ['y'],
  'gate.reject': ['n'],
  'gate.cancel': ['escape', 'ctrl+c'],
  'question.up': ['up', 'ctrl+p'],
  'question.down': ['down', 'ctrl+n'],
  'question.toggle': ['space'],
  'question.confirm': ['enter'],
  'question.skip': ['escape'],
  'question.cancel': ['ctrl+c'],
  'picker.up': ['up', 'ctrl+p'],
  'picker.down': ['down', 'ctrl+n'],
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

  it('adds the surface cancel key to the library row that closes the search', () => {
    // The search owns the keyboard while it is open, so the key has to be
    // installed where the library reads it rather than intercepted here.
    expect(keysFor(defaultKeymap(), 'tui.altScreen.searchClose')).toEqual(['escape', 'ctrl+c'])
  })

  it('lets the reader take the added key back off that row', () => {
    const map = resolveKeymap({ 'tui.altScreen.searchClose': ['escape'] })
    expect(keysFor(map, 'tui.altScreen.searchClose')).toEqual(['escape'])
    expect(keysFor(map, 'surface.interrupt')).toEqual(['ctrl+c'])
  })

  it('adds the navigation aliases to the library list the completion menu uses', () => {
    // The menu belongs to the library's editor, so the aliases have to be
    // installed there rather than on an action this surface answers.
    expect(keysFor(defaultKeymap(), 'tui.select.up')).toEqual(['up', 'ctrl+p'])
    expect(keysFor(defaultKeymap(), 'tui.select.down')).toEqual(['down', 'ctrl+n'])
  })

  it('lets the reader take a navigation alias back off a library row', () => {
    const map = resolveKeymap({ 'tui.select.up': ['up'] })
    expect(keysFor(map, 'tui.select.up')).toEqual(['up'])
    // The surface's own lists keep their aliases: the rows are separate.
    expect(keysFor(map, 'picker.up')).toEqual(['up', 'ctrl+p'])
  })

  it('keeps the navigation aliases out of the listener that runs before the editor', () => {
    // The surface answers a surface or chord key before the focused editor, so a
    // row there would take Ctrl+P/Ctrl+N away from the completion menu.
    const claimed = ACTION_CATALOG
      .filter(entry => entry.layer === 'surface' || entry.layer === 'chord')
      .flatMap(entry => keysFor(defaultKeymap(), entry.id))
    expect(claimed).not.toContain('ctrl+p')
    expect(claimed).not.toContain('ctrl+n')
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

  it('reads a shifted character as typing rather than as a key of its own', () => {
    // A terminal reports shift+C as a capital C, which is a character the reader
    // types: a binding on it would swallow that character instead of answering.
    expect(() => resolveKeymap({ 'surface.interrupt': 'shift+c' })).toThrow(/surface.interrupt/)
    expect(() => resolveKeymap({ 'chord.prefix': 'shift+x' })).toThrow(/chord.prefix/)
  })

  it('takes a bare character for the approval gate and the chord, which are theirs while armed', () => {
    expect(keysFor(resolveKeymap({ 'gate.allow': 'a' }), 'gate.allow')).toEqual(['a'])
    expect(keysFor(resolveKeymap({ 'chord.model': 'n' }), 'chord.model')).toEqual(['n'])
  })

  it('refuses a combination the library never matches, however it is named', () => {
    // These parse cleanly but no terminal press can reach them, so accepting one
    // would silently cost the reader the action.
    expect(() => resolveKeymap({ 'surface.effort': 'ctrl+escape' })).toThrow(/never matches/)
    expect(() => resolveKeymap({ 'surface.effort': 'ctrl+f1' })).toThrow(/never matches/)
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

  it('refuses two actions one press reaches, however each of them spells it', () => {
    // A terminal cannot tell ctrl+m from Return, nor ctrl+i from Tab, so a pair
    // written with different spellings is still one press answering two actions.
    expect(() => resolveKeymap({ 'gate.allow': 'enter', 'gate.reject': 'ctrl+m' })).toThrow(/gate\.(allow|reject)/)
    expect(() => resolveKeymap({ 'prompt.submit': 'ctrl+m' })).toThrow(/prompt\.newLine/)
    expect(() => resolveKeymap({ 'chord.prefix': 'ctrl+m' })).toThrow(/prompt\.newLine/)
  })

  it('takes every row at its own shipped key, whatever the rules say about that key', () => {
    // A document that spells out the default changes nothing; refusing it would
    // cost the reader the whole section over a line they did not need to write.
    for (const entry of ACTION_CATALOG) {
      if (entry.defaultKeys.length === 0) continue
      expect(() => resolveKeymap({ [entry.id]: [...entry.defaultKeys] }), entry.id).not.toThrow()
    }
  })

  it('refuses a key the library already reads, even a row the reader never wrote', () => {
    // The matcher reads a shipped row and a moved one the same way, so accepting
    // this would make ctrl+w delete the draft instead of sending it.
    expect(() => resolveKeymap({ 'prompt.submit': 'ctrl+w' })).toThrow(/tui\.editor\.deleteWordBackward/)
    expect(() => resolveKeymap({ 'tui.editor.cursorLineEnd': 'ctrl+u' })).toThrow(/deleteToLineStart/)
  })

  it('refuses two actions one byte cannot tell apart, however each is spelled', () => {
    // A bare terminal reports a line feed for both Return and Ctrl+J, and one
    // control byte carries both spellings of Ctrl+-: the surface answers these
    // layers first row first, so the second row would never be reached.
    expect(() => resolveKeymap({ 'gate.allow': 'ctrl+j', 'gate.reject': 'enter' })).toThrow(/gate\.allow and gate\.reject/)
    expect(() => resolveKeymap({ 'gate.allow': 'ctrl+-', 'gate.reject': 'ctrl+_' })).toThrow(/gate\.allow and gate\.reject/)
    expect(() => resolveKeymap({ 'question.confirm': 'ctrl+j', 'question.skip': 'enter' })).toThrow(/bound to both question\./)
  })

  it('refuses two actions one escape-prefixed byte cannot tell apart', () => {
    // Escape and a letter is a loose spelling in a bare terminal: it reaches
    // Alt+Up as readily as Alt+P, so a decision bound to one of them would
    // answer for the other.
    expect(() => resolveKeymap({ 'gate.allow': 'alt+up', 'gate.reject': 'alt+p' })).toThrow(/gate\.allow and gate\.reject/)
    expect(() => resolveKeymap({ 'gate.allow': 'alt+enter', 'gate.reject': 'ctrl+alt+m' })).toThrow(/gate\.allow and gate\.reject/)
  })

  it('lets one row repeat a press without inventing a clash', () => {
    // Return and Ctrl+M are one byte, and a reader who writes both on one row
    // changes no other row's reach: the shipped search pair keeps the single
    // overlap the library already gives it, on the line feed.
    const map = resolveKeymap({ 'tui.altScreen.searchNext': ['enter', 'ctrl+g', 'ctrl+m'] })
    expect(keysFor(map, 'tui.altScreen.searchNext')).toEqual(['enter', 'ctrl+g', 'ctrl+m'])
  })

  it('refuses a library key whose byte the library already answers', () => {
    // One control byte carries two spellings, and the library reads the row it
    // shipped first: a reader moving another row onto the same byte would be
    // pressing the shipped row instead.
    expect(() => resolveKeymap({ 'tui.editor.cursorLineEnd': 'ctrl+_' })).toThrow(/tui\.editor\.cursorLineEnd/)
  })

  it('lets one action carry two spellings of the same press', () => {
    // Writing the same key twice is the reader's way of saying one thing, not a
    // clash: only two rows fighting over the byte would be one that never runs.
    const map = resolveKeymap({ 'gate.allow': ['enter', 'ctrl+m'] })
    expect(keysFor(map, 'gate.allow')).toEqual(['enter', 'ctrl+m'])
  })

  it('keeps send on Ctrl+J available while Return still writes the line', () => {
    // The bar answers Return and a line feed itself before the library matcher
    // runs, so moving send onto Ctrl+J is a choice and not an overlap.
    const map = resolveKeymap({ 'prompt.submit': ['ctrl+j'], 'prompt.newLine': ['enter', 'shift+enter'] })
    expect(keysFor(map, 'prompt.submit')).toEqual(['ctrl+j'])
  })

  it('refuses a key the viewport reads first, whichever side of the pair was written', () => {
    expect(() => resolveKeymap({ 'surface.toolDetail': 'pageUp' })).toThrow(/tui\.altScreen\.pageUp/)
    // A second key or a gate key is read after the viewport too, so it would be
    // a binding that never answers.
    expect(() => resolveKeymap({ 'chord.model': 'pageUp' })).toThrow(/tui\.altScreen\.pageUp/)
    expect(() => resolveKeymap({ 'gate.allow': 'pageUp' })).toThrow(/tui\.altScreen\.pageUp/)
    // The other direction: moving the viewport row onto a key the surface
    // answers would take that key away from the surface.
    expect(() => resolveKeymap({ 'tui.altScreen.search': 'ctrl+t' })).toThrow(/surface\.effort/)
    // The pair is read from the sequences, not from the spelling: this search
    // key and that gate key are one escape and a letter in a bare terminal.
    expect(() => resolveKeymap({ 'tui.altScreen.search': 'alt+p', 'gate.reject': 'alt+up' })).toThrow(/tui\.altScreen\.search/)
    // The overlaps the library ships are its own business and stay allowed.
    expect(() => resolveKeymap({})).not.toThrow()
  })

  it('refuses Return on a library row while the prompt bar answers it', () => {
    // The library reads Return as a line break before it looks for a row, and
    // the bar answers it before the library: a library row that took it would
    // be the row that never runs.
    expect(() => resolveKeymap({ 'tui.editor.cursorLineEnd': 'enter' })).toThrow(/tui\.editor\.cursorLineEnd/)
    expect(() => resolveKeymap({ 'tui.editor.cursorLineEnd': 'ctrl+m' })).toThrow(/tui\.editor\.cursorLineEnd/)
    // A reader who sends with Return keeps it: the bar still answers the press.
    expect(keysFor(resolveKeymap({ 'prompt.submit': ['enter'], 'prompt.newLine': ['shift+enter'] }), 'prompt.submit')).toEqual(['enter'])
    expect(() => resolveKeymap({ 'prompt.submit': ['enter'], 'prompt.newLine': ['shift+enter'], 'tui.editor.cursorLineEnd': 'enter' })).toThrow(/tui\.editor\.cursorLineEnd/)
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

  it('shadows the library delete forward with the quit key the surface ships', () => {
    // The bar keeps its own key while it holds text, so the shadow is the
    // design rather than a loss, and /keys does not report it as one.
    const quit = shadowsOf(defaultKeymap()).find(entry => entry.winner === 'surface.quit')
    expect(quit?.loser).toBe('tui.editor.deleteCharForward')
    expect(quit?.key).toBe('ctrl+d')
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
