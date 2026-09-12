import { describe, expect, it } from 'vitest'
import { TUI_SETTINGS_NAMESPACE, parseSettings,
  TuiSettingsSchema, defaultSettings, toOverrides } from '@/theme-settings.ts'

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
