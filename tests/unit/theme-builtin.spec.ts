import { describe, expect, it } from 'vitest'
import { builtinNames, SHIPPED_THEME } from '@/theme-files.ts'
import { parseSettings, themeLayer, toOverrides } from '@/theme-settings.ts'
import { mergeTokenSpec, PALETTE_NAMES, TUI_TOKENS, type PaletteName, type StyleSpec } from '@/theme-tokens.ts'
import { createTheme } from '@/theme.ts'
import { builtinLibrary } from '../support/themes.ts'

/** Every capability the surface can meet, so no theme is only drawn on one. */
const MODES = ['truecolor', '256', '16', 'none'] as const

/** The theme the reader asked to be brought over, by the name it answers to. */
const VIOLET = 'violet-orbit'

/** The surface's own theme: the shipped table, in the blue the project answers to. */
const BLUE = 'deepseek-blue'

const library = builtinLibrary()

/** The theme as a renderer holds it, which is what a reader actually sees. */
const themed = (name: string, mode: (typeof MODES)[number] = 'truecolor') =>
  createTheme(mode, toOverrides(parseSettings({ theme: name }), library))

describe('the shipped themes', () => {
  it('ships a file for every name it offers', () => {
    // Sorted on both sides: which files exist is the claim, and the order a
    // library offers names in is the loader's business rather than this one's.
    expect([...builtinNames(library)].sort()).toEqual([SHIPPED_THEME, VIOLET, BLUE].sort())
  })

  it('names only elements and palette entries the surface has', () => {
    // A theme file is data and js-yaml accepts any key, so a name that drifted
    // out of the token list has to fail here rather than paint nothing.
    const palette = new Set<string>(PALETTE_NAMES)
    const tokens = new Set<string>(TUI_TOKENS)
    for (const theme of library.list()) {
      for (const entry of Object.keys(theme.palette)) {
        expect(palette.has(entry), `${theme.name} names palette entry ${entry}`).toBe(true)
      }
      for (const token of Object.keys(theme.tokens)) {
        expect(tokens.has(token), `${theme.name} names element ${token}`).toBe(true)
      }
    }
  })

  it('names every element and palette entry, so a copy is a complete theme', () => {
    // A reference that leaves entries out is a diff against something the reader
    // cannot see, and it lets a new element ship with no theme answering for it.
    for (const theme of library.list()) {
      expect(Object.keys(theme.tokens).sort(), `${theme.name} elements`).toEqual([...TUI_TOKENS].sort())
      expect(Object.keys(theme.palette).sort(), `${theme.name} palette`).toEqual([...PALETTE_NAMES].sort())
    }
  })

  it('names only colours the surface can draw', () => {
    // A misspelled hex survives js-yaml, so it is refused here instead.
    const hex = /^#[0-9a-f]{6}$/iu
    const palette = new Set<string>(PALETTE_NAMES)
    for (const theme of library.list()) {
      const specs = Object.values(theme.tokens).filter((spec): spec is StyleSpec => spec !== undefined)
      const colours = [
        ...Object.values(theme.palette),
        ...specs.flatMap(spec => [spec.fg, spec.bg]),
      ].filter((value): value is string => typeof value === 'string')
      for (const colour of colours) {
        const drawable = hex.test(colour) || palette.has(colour as PaletteName)
        expect(drawable, `${theme.name} cannot draw ${colour}`).toBe(true)
      }
    }
  })

  it('draws on every terminal the surface can meet', () => {
    for (const name of library.names()) {
      for (const mode of MODES) {
        expect(() => themed(name, mode), `${name} in ${mode}`).not.toThrow()
      }
    }
  })

  it('draws an element a theme moves no shade for from the palette it did move', () => {
    // The palette half is what makes a full table maintainable: an element the
    // theme writes no literal for still follows the theme's own shades.
    const theme = themed(VIOLET)
    expect(theme.style('transcript.reasoning.body', 'x')).toContain('38;2;103;109;149')
  })
})

describe('deepseek-blue', () => {
  it('draws the surface in the brand blue rather than the shipped cyan', () => {
    expect(themed(BLUE).style('markdown.heading', 'x')).toContain('38;2;109;134;255')
  })

  it('leaves the semantic shades in the hues a reader already reads them in', () => {
    // A theme that repainted these would make every reader learn them again on
    // the one screen where reading them wrong costs the most.
    expect(themed(BLUE).style('tool.diff.added', 'x')).toContain('38;2;34;197;94')
    expect(themed(BLUE).style('tool.diff.removed', 'x')).toContain('38;2;239;68;68')
    expect(themed(BLUE).style('markdown.diagram.warning', 'x')).toContain('38;2;251;191;36')
  })

  it('gives a tool card the brand blue, where the shipped table gives it a warning shade', () => {
    // The label is the loudest thing on the row, and nothing about a call is wrong.
    expect(themed(BLUE).style('tool.title', 'x')).toContain('38;2;109;134;255')
    expect(themed(SHIPPED_THEME).style('tool.title', 'x')).toContain('38;2;215;175;95')
  })

  it('holds the bar a reader types into in the pale blue rather than one more grey', () => {
    expect(themed(BLUE).style('editor.border', 'x')).toContain('38;2;169;188;255')
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
    // blue from the same family; a reader scanning for the call cannot tell where
    // the name stops. Lifting the argument out of that family is what makes one
    // row readable as two facts.
    const theme = themed(VIOLET)
    expect(theme.style('tool.title', 'x')).toContain('38;2;129;151;247')
    expect(theme.style('tool.args', 'x')).toContain('38;2;210;201;240')
    expect(theme.style('tool.subcall.args', 'x')).toContain('38;2;210;201;240')
  })

  it('merges a reader field over a themed element field by field', () => {
    // The two layers meet on one element: the reader naming one attribute must
    // not discard the shade the theme gave that same element.
    const overrides = toOverrides(parseSettings({ theme: VIOLET, tokens: { 'tool.title': { bold: true } } }), library)
    expect(mergeTokenSpec('tool.title', overrides.tokens, themeLayer(overrides)))
      .toEqual({ fg: '#8197f7', bold: true })
  })

  it('still lets the reader win on any element it set', () => {
    const theme = createTheme('truecolor', toOverrides(parseSettings({
      theme: VIOLET,
      tokens: { 'tool.title': { fg: '#ff0000' } },
    }), library))
    expect(theme.style('tool.title', 'x')).toContain('38;2;255;0;0')
  })
})
