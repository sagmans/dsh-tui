import { describe, expect, it } from 'vitest'
import { presetTokens, THEME_NAMES, THEME_PRESETS } from '@/theme-presets.ts'
import { mergeTokenSpec, PALETTE_NAMES, TUI_TOKENS, type PaletteName, type StyleSpec } from '@/theme-tokens.ts'
import { createTheme } from '@/theme.ts'
import { parseSettings, toOverrides } from '@/theme-settings.ts'

/** Every capability the surface can meet, so no theme is only drawn on one. */
const MODES = ['truecolor', '256', '16', 'none'] as const

/** The theme the reader asked to be brought over, by the name it answers to. */
const VIOLET = 'violet-orbit' as const

/** The theme as a renderer holds it, which is what a reader actually sees. */
const themed = (name: string, mode: (typeof MODES)[number] = 'truecolor') =>
  createTheme(mode, toOverrides(parseSettings({ theme: name })))

describe('the shipped themes', () => {
  it('ships a table for every name it offers', () => {
    expect(Object.keys(THEME_PRESETS).sort()).toEqual([...THEME_NAMES].sort())
  })

  it('names only elements and palette entries the surface has', () => {
    // The tables are typed, but a theme is data: a name that drifted out of the
    // token list has to fail here rather than paint nothing for the reader.
    const palette = new Set<string>(PALETTE_NAMES)
    const tokens = new Set<string>(TUI_TOKENS)
    for (const [name, preset] of Object.entries(THEME_PRESETS)) {
      for (const entry of Object.keys(preset.palette)) {
        expect(palette.has(entry), `${name} names palette entry ${entry}`).toBe(true)
      }
      for (const token of Object.keys(preset.tokens)) {
        expect(tokens.has(token), `${name} names element ${token}`).toBe(true)
      }
    }
  })

  it('names only colours the surface can draw', () => {
    // A misspelled hex is silent at runtime, so it is refused here instead.
    const hex = /^#[0-9a-f]{6}$/iu
    const palette = new Set<string>(PALETTE_NAMES)
    for (const [name, preset] of Object.entries(THEME_PRESETS)) {
      const specs = Object.values(preset.tokens).filter((spec): spec is StyleSpec => spec !== undefined)
      const colours = [
        ...Object.values(preset.palette),
        ...specs.flatMap(spec => [spec.fg, spec.bg]),
      ].filter((value): value is string => typeof value === 'string')
      for (const colour of colours) {
        const drawable = hex.test(colour) || palette.has(colour as PaletteName)
        expect(drawable, `${name} cannot draw ${colour}`).toBe(true)
      }
    }
  })

  it('draws on every terminal the surface can meet', () => {
    for (const name of THEME_NAMES) {
      for (const mode of MODES) {
        expect(() => themed(name, mode), `${name} in ${mode}`).not.toThrow()
      }
    }
  })

  it('leaves an element it does not name on the palette it ships', () => {
    // A theme is a layer, not a replacement: everything it says nothing about
    // still has to be drawn, and drawn from the shades it did set.
    const theme = themed(VIOLET)
    expect(theme.style('transcript.reasoning.body', 'x')).toContain('38;2;103;109;149')
  })
})

describe('violet-orbit', () => {
  it('replaces the shipped accent family with its own violet', () => {
    const theme = themed(VIOLET)
    // status.prefix names the palette rather than a literal, so it proves the
    // palette half of the theme landed, not just the per-element half.
    expect(theme.style('status.prefix', 'x')).toContain('38;2;128;128;255')
    expect(theme.style('picker.border', 'x')).toContain('38;2;52;54;82')
  })

  it('leaves a reader turn on the prompt shade alone, with no band behind it', () => {
    // The box is what separates a prompt from the prose around it, and a filled
    // row inside that box is a second treatment of the same fact: it reads as a
    // selected row rather than as the reader's own words.
    const style = themed(VIOLET).style('transcript.user', 'x')
    expect(style).toContain('38;2;240;241;255')
    expect(style).not.toContain('48;2;')
  })

  it('draws a tool label periwinkle rather than the shipped amber', () => {
    expect(themed(VIOLET).style('tool.title', 'x')).toContain('38;2;129;151;247')
  })

  it('keeps the shades it borrowed for code, terminal, and links', () => {
    const theme = themed(VIOLET)
    expect(theme.style('markdown.code', 'x')).toContain('38;2;251;158;36')
    expect(theme.style('tool.terminal.cwd', 'x')).toContain('38;2;153;246;228')
    expect(theme.style('markdown.link', 'x')).toContain('38;2;147;197;253')
  })

  it('draws a tool argument lighter than the label beside it', () => {
    // The label and the argument share a row, and pi hands both jobs a mid-tone
    // blue from the same family; a reader scanning for the call cannot tell
    // where the name stops. Lifting the argument out of that family is what
    // makes one row readable as two facts.
    const theme = themed(VIOLET)
    expect(theme.style('tool.title', 'x')).toContain('38;2;129;151;247')
    expect(theme.style('tool.args', 'x')).toContain('38;2;210;201;240')
    expect(theme.style('tool.subcall.args', 'x')).toContain('38;2;210;201;240')
  })

  it('merges a reader field over a themed element field by field', () => {
    // The two layers meet on one element: the reader naming one attribute must
    // not discard the shade the theme gave that same element.
    const overrides = toOverrides(parseSettings({ theme: VIOLET, tokens: { 'tool.title': { bold: true } } }))
    expect(mergeTokenSpec('tool.title', overrides.tokens, presetTokens(overrides.preset)))
      .toEqual({ fg: '#8197f7', bold: true })
  })

  it('still lets the reader win on any element it set', () => {
    const theme = createTheme('truecolor', toOverrides(parseSettings({
      theme: VIOLET,
      tokens: { 'tool.title': { fg: '#ff0000' } },
    })))
    expect(theme.style('tool.title', 'x')).toContain('38;2;255;0;0')
  })
})
