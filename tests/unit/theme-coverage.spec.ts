import { describe, expect, it } from 'vitest'
import { DEFAULT_PALETTE, DEFAULT_TOKENS, TUI_TOKENS, type TuiToken, resolveToken } from '@/theme-tokens.ts'
import { createTheme } from '@/theme.ts'
import { parseSettings, toOverrides } from '@/theme-settings.ts'
import { renderThemeTable } from '@/theme-command.ts'

/** Every capability the surface can meet, so no token is only tested in one. */
const MODES = ['truecolor', '256', '16', 'none'] as const

describe('token coverage', () => {
  it('resolves every token in every capability without throwing', () => {
    for (const mode of MODES) {
      for (const token of TUI_TOKENS) {
        expect(() => resolveToken(token, new Map(), DEFAULT_PALETTE, mode), `${token} in ${mode}`).not.toThrow()
      }
    }
  })

  it('emits nothing at all when colour is off, for every token', () => {
    // The NO_COLOR contract is all-or-nothing: one token emitting an attribute
    // would mean a reader who asked for no styling still got some.
    for (const token of TUI_TOKENS) {
      const style = resolveToken(token, new Map(), DEFAULT_PALETTE, 'none')
      expect(style.prefix, `${token} styled with colour off`).toBe('')
      expect(style.suffix, `${token} reset with colour off`).toBe('')
    }
  })

  it('ships no hidden element and no glyph', () => {
    for (const token of TUI_TOKENS) {
      expect(DEFAULT_TOKENS[token].hidden ?? false, `${token} ships hidden`).toBe(false)
      expect(DEFAULT_TOKENS[token].glyph ?? '', `${token} ships a glyph`).toBe('')
    }
  })

  it('reaches every token through the theme the renderers hold', () => {
    const theme = createTheme('truecolor')
    for (const token of TUI_TOKENS) {
      expect(theme.visible(token), `${token} is invisible by default`).toBe(true)
      expect(() => theme.style(token, 'x'), `${token} cannot be styled`).not.toThrow()
    }
  })

  it('lets every token be overridden, which is what customizable means', () => {
    // A token a reader cannot change is not customizable, whatever the table
    // says; this drives each one through an override and requires an effect.
    for (const token of TUI_TOKENS) {
      const settings = parseSettings({ tokens: { [token]: { fg: '#ff00ff', bold: true } } })
      const theme = createTheme('truecolor', toOverrides(settings))
      const styled = theme.style(token as TuiToken, 'x')
      expect(styled, `${token} ignored its override`).toContain('38;2;255;0;255')
    }
  })

  it('lets every token be hidden', () => {
    for (const token of TUI_TOKENS) {
      const settings = parseSettings({ tokens: { [token]: { hidden: true } } })
      const theme = createTheme('truecolor', toOverrides(settings))
      expect(theme.visible(token as TuiToken), `${token} cannot be hidden`).toBe(false)
    }
  })
})

describe('/theme', () => {
  it('lists every element with the value in force and where it came from', () => {
    const overrides = toOverrides(parseSettings({ tokens: { 'transcript.user': { fg: '#ff0000' } } }))
    const lines = renderThemeTable(overrides)
    for (const token of TUI_TOKENS) {
      expect(lines.some(line => line.includes(token)), `${token} missing from /theme`).toBe(true)
    }
    expect(lines.some(line => line.includes('transcript.user') && line.includes('#ff0000') && line.includes('override'))).toBe(true)
    expect(lines.some(line => line.includes('transcript.reasoning.body') && line.includes('palette'))).toBe(true)
  })
})
