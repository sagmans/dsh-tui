import { describe, expect, it } from 'vitest'
import { defaultKeymap, keysFor } from '@/input/actions.ts'
import { createTheme } from '@/theme.ts'
import { TUI_SETTINGS_NAMESPACE, parseSettings,
  TuiSettingsSchema, defaultSettings, readScope, toOverrides } from '@/theme-settings.ts'

describe('the dsh-tui settings section', () => {
  it('owns the namespace the reader writes in settings.yaml', () => {
    expect(TUI_SETTINGS_NAMESPACE).toBe('dsh-tui')
  })

  it('accepts an empty section, because every token has a default', () => {
    // Nothing written means nothing overridden; the shipped table fills the rest.
    expect(parseSettings({})).toEqual({
      palette: {},
      tokens: {},
      subcalls: 'inline',
      mermaid: 'streaming',
      prefixes: ['ctrl+x'],
      prefixWindow: 2,
      keymap: defaultKeymap(),
      history: { enabled: true, ghost: true, maxEntries: 2000 },
    })
  })

  it('draws nested PTC calls until the reader folds them', () => {
    expect(parseSettings({}).subcalls).toBe('inline')
    expect(parseSettings({ subcalls: 'collapsed' }).subcalls).toBe('collapsed')
  })

  it('rejects a display value the surface does not have', () => {
    expect(() => parseSettings({ subcalls: 'expanded' })).toThrow()
  })

  it('draws mermaid fences as diagrams until the reader says otherwise', () => {
    expect(parseSettings({}).mermaid).toBe('streaming')
    expect(parseSettings({ mermaid: 'off' }).mermaid).toBe('off')
    expect(parseSettings({ mermaid: 'final' }).mermaid).toBe('final')
  })

  it('rejects a mermaid mode the surface does not have', () => {
    expect(() => parseSettings({ mermaid: 'sometimes' })).toThrow()
  })

  it('starts a chord with ctrl+x and waits two seconds for its second key', () => {
    expect(parseSettings({}).prefixes).toEqual(['ctrl+x'])
    expect(parseSettings({}).prefixWindow).toBe(2)
  })

  it('takes another prefix key, and a window the reader chooses', () => {
    expect(parseSettings({ prefix: 'alt+x' }).prefixes).toEqual(['alt+x'])
    expect(parseSettings({ prefix: 'ctrl+shift+m' }).prefixes).toEqual(['ctrl+shift+m'])
    expect(parseSettings({ prefixWindow: 0 }).prefixWindow).toBe(0)
    expect(parseSettings({ prefixWindow: 5 }).prefixWindow).toBe(5)
  })

  it('rejects a prefix the reader could never use, naming why', () => {
    expect(() => parseSettings({ prefix: 'x' })).toThrow(/modifier chord/)
    expect(() => parseSettings({ prefix: 'ctrl+c' })).toThrow(/surface/)
    expect(() => parseSettings({ prefix: 'ctrl+s' })).toThrow(/submit/)
    expect(() => parseSettings({ prefixWindow: -1 })).toThrow()
    expect(() => parseSettings({ prefixWindow: 600 })).toThrow()
  })

  it('records prompts by default and lets the reader narrow or stop it', () => {
    expect(parseSettings({}).history).toEqual({ enabled: true, ghost: true, maxEntries: 2000 })
    expect(parseSettings({ history: { ghost: false } }).history).toEqual({ enabled: true, ghost: false, maxEntries: 2000 })
    expect(parseSettings({ history: { enabled: false } }).history.enabled).toBe(false)
    expect(parseSettings({ history: { maxEntries: 50 } }).history.maxEntries).toBe(50)
  })

  it('rejects a history cap outside what the store can hold', () => {
    expect(() => parseSettings({ history: { maxEntries: 0 } })).toThrow()
    expect(() => parseSettings({ history: { maxEntries: 20001 } })).toThrow()
  })

  it('rejects an unknown history key so a typo fails loudly', () => {
    expect(() => parseSettings({ history: { ghosting: true } })).toThrow(/history/)
  })

  it('rejects an unknown section key so a typo fails loudly', () => {
    expect(() => parseSettings({ subcall: 'inline' })).toThrow(/subcall/)
  })

  it('rejects an unknown token so a typo fails loudly', () => {
    expect(() => parseSettings({ tokens: { 'transcript.reasoning.bdy': { fg: '#fff' } } })).toThrow()
  })

  it('rejects a colour that is not a colour', () => {
    expect(() => parseSettings({ tokens: { 'transcript.user': { fg: 'chartreuse' } } })).toThrow()
  })

  it('rejects a palette entry the surface does not have', () => {
    // Schemastery ignores undeclared palette keys, so a misspelling would
    // otherwise be accepted and do nothing at all.
    expect(() => parseSettings({ palette: { mutd: '#555555' } })).toThrow(/palette/)
  })

  it('reports a refused section to the caller, not only to stderr', () => {
    const problems: string[] = []
    const settings = readScope({ get: () => ({ tokens: { 'transcript.reasoning.bdy': { fg: '#fff' } } }) }, message => problems.push(message))
    expect(settings).toEqual({
      palette: {},
      tokens: {},
      subcalls: 'inline',
      mermaid: 'streaming',
      prefixes: ['ctrl+x'],
      prefixWindow: 2,
      keymap: defaultKeymap(),
      history: { enabled: true, ghost: true, maxEntries: 2000 },
    })
    expect(problems[0]).toContain('transcript.reasoning.bdy')
  })

  it('accepts hex, a palette name, and an index', () => {
    expect(() => parseSettings({ tokens: { 'transcript.user': { fg: '#ff0000' } } })).not.toThrow()
    expect(() => parseSettings({ tokens: { 'transcript.user': { fg: 'muted' } } })).not.toThrow()
    expect(() => parseSettings({ tokens: { 'transcript.user': { fg: 8 } } })).not.toThrow()
    expect(() => parseSettings({ palette: { muted: '#777777' } })).not.toThrow()
  })

  it('turns a section into overrides', () => {
    const overrides = toOverrides(parseSettings({ tokens: { 'transcript.user': { fg: '#ff0000' } } }))
    expect(overrides.tokens.get('transcript.user')).toEqual({ fg: '#ff0000' })
    expect(overrides.palette.muted).toBeDefined()
  })

  it('lets a palette override win over the shipped palette', () => {
    const overrides = toOverrides(parseSettings({ palette: { muted: '#777777' } }))
    expect(overrides.palette.muted).toBe('#777777')
  })
})

describe('the keys section', () => {
  it('keeps every shipped key when the reader writes nothing', () => {
    const settings = parseSettings({})
    expect(keysFor(settings.keymap, 'prompt.submit')).toEqual(['ctrl+enter', 'alt+enter', 'ctrl+s'])
    expect(keysFor(settings.keymap, 'tui.editor.yank')).toEqual(['ctrl+y'])
    expect(settings.keymap.written.size).toBe(0)
  })

  it('takes one action, one key or a list, and leaves the rest shipped', () => {
    const settings = parseSettings({ keys: { 'surface.effort': 'ctrl+e', 'prompt.submit': ['ctrl+g'] } })
    expect(keysFor(settings.keymap, 'surface.effort')).toEqual(['ctrl+e'])
    expect(keysFor(settings.keymap, 'prompt.submit')).toEqual(['ctrl+g'])
    expect(keysFor(settings.keymap, 'surface.toolDetail')).toEqual(['ctrl+o'])
    expect([...settings.keymap.written].sort()).toEqual(['prompt.submit', 'surface.effort'])
  })

  it('takes the chord starter through the map, and keeps the old spelling working', () => {
    expect(parseSettings({ keys: { 'chord.prefix': 'alt+z' } }).prefixes).toEqual(['alt+z'])
    expect(parseSettings({ prefix: 'alt+z' }).prefixes).toEqual(['alt+z'])
    expect(keysFor(parseSettings({ prefix: 'alt+z' }).keymap, 'chord.prefix')).toEqual(['alt+z'])
  })

  it('takes the map spelling from the section a registered scope hands back', () => {
    // A registration fills every declared field, so the old spelling reads as
    // written even when the document never mentioned it. Only the field the
    // document wrote decides which spelling the section is using.
    const filled = TuiSettingsSchema({ keys: { 'chord.prefix': 'alt+z' } })
    expect(parseSettings(filled).prefixes).toEqual(['alt+z'])
    expect(keysFor(parseSettings(filled).keymap, 'chord.prefix')).toEqual(['alt+z'])
  })

  it('takes a list of chord starters, one way in each', () => {
    expect(parseSettings({ keys: { 'chord.prefix': ['ctrl+x', 'ctrl+g'] } }).prefixes).toEqual(['ctrl+x', 'ctrl+g'])
  })

  it('refuses both spellings of the chord starter at once', () => {
    expect(() => parseSettings({ prefix: 'alt+z', keys: { 'chord.prefix': 'ctrl+a' } })).toThrow(/chord\.prefix/)
  })

  it('rejects an action the surface does not have, naming it', () => {
    expect(() => parseSettings({ keys: { 'surface.nope': 'ctrl+g' } })).toThrow(/surface\.nope/)
  })

  it('rejects a key the reader could never press', () => {
    expect(() => parseSettings({ keys: { 'surface.effort': 'ctrl+q' } })).toThrow(/terminal/)
    expect(() => parseSettings({ keys: { 'surface.effort': 'e' } })).toThrow(/surface\.effort/)
    expect(() => parseSettings({ keys: { 'surface.effort': 'meta+e' } })).toThrow(/surface\.effort/)
  })

  it('rejects two actions of one layer claiming one key', () => {
    expect(() => parseSettings({ keys: { 'surface.effort': 'ctrl+o' } })).toThrow(/surface\.toolDetail/)
  })

  it('falls back to the shipped map when the reader wrote one the surface refuses', () => {
    const settings = readScope({ get: () => ({ keys: { 'surface.nope': 'ctrl+g' } }) }, () => {})
    expect(settings.prefixes).toEqual(['ctrl+x'])
    expect(keysFor(settings.keymap, 'prompt.submit')).toEqual(['ctrl+enter', 'alt+enter', 'ctrl+s'])
  })
})

describe('a resolved section', () => {
  it('does not report the schema fill-in as an override', () => {
    // A registered scope hands back every declared key, empty ones included.
    // Counting those as overrides blanked the shipped defaults and made
    // /theme claim every element had been overridden.
    const written = parseSettings({ tokens: { 'status.cwd': { fg: '#ff00ff' } } })
    expect(Object.keys(written.tokens)).toEqual(['status.cwd'])
    expect(written.tokens['status.model']).toBeUndefined()
  })

  it('does not report the default palette as overridden', () => {
    const written = parseSettings({ palette: { muted: '#5c5c5c' } })
    expect(Object.keys(written.palette)).toEqual(['muted'])
  })

  it('keeps a resolved section round-tripping to the same overrides', () => {
    const resolved = parseSettings(TuiSettingsSchema({ tokens: { 'status.cwd': { fg: '#ff00ff' } } }))
    expect(Object.keys(resolved.tokens)).toEqual(['status.cwd'])
  })

  it('leaves the shipped default reachable for an untouched element', () => {
    const theme = createTheme('truecolor', toOverrides(parseSettings(TuiSettingsSchema({}))))
    // An untouched muted element must still be muted, not blanked to plain.
    expect(theme.style('status.model', 'x')).toContain('38;2;')
  })
})
