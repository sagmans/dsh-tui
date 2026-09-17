import { describe, expect, it } from 'vitest'
import { createTheme } from '@/theme.ts'
import { TUI_SETTINGS_NAMESPACE, parseSettings,
  TuiSettingsSchema, defaultSettings, readScope, toOverrides } from '@/theme-settings.ts'

describe('the dsh-tui settings section', () => {
  it('owns the namespace the reader writes in settings.yaml', () => {
    expect(TUI_SETTINGS_NAMESPACE).toBe('dsh-tui')
  })

  it('accepts an empty section, because every token has a default', () => {
    // Nothing written means nothing overridden; the shipped table fills the rest.
    expect(parseSettings({})).toEqual({ palette: {}, tokens: {} })
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
    expect(settings).toEqual({ palette: {}, tokens: {} })
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
