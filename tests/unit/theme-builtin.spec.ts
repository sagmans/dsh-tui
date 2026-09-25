import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { builtinThemesDir, exportTheme, loadThemes } from '@/theme-files.ts'
import { parseSettings, themeLayer, toOverrides } from '@/theme-settings.ts'
import { mergeTokenSpec } from '@/theme-resolver.ts'
import { TUI_TOKENS } from '@/theme-tokens.ts'
import { createTheme } from '@/theme.ts'
import { builtinLibrary } from '../support/themes.ts'

/** Every capability the surface can meet, so no theme is only drawn on one. */
const MODES = ['truecolor', '256', '16', 'none'] as const

/** The table under every theme, which is what the compiled defaults are. */
const untinted = (mode: (typeof MODES)[number] = 'truecolor') => createTheme(mode)

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
    // The names are the loader's business; what the package promises is that every
    // one it offers is backed by a file a reader can copy and edit, so losing one
    // fails here rather than in `/theme export`.
    const home = mkdtempSync(join(tmpdir(), 'dsh-theme-builtin-'))
    try {
      const shipped = loadThemes(home, builtinThemesDir())
      expect(shipped.names().length).toBeGreaterThan(0)
      for (const name of shipped.names()) {
        expect(shipped.get(name)?.builtin, `${name} is not shipped`).toBe(true)
        expect(shipped.get(name)?.path, `${name} has no file`).not.toBe('')
        expect(exportTheme(shipped, name).ok, `${name} cannot be exported`).toBe(true)
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('draws on every terminal the surface can meet', () => {
    // A shipped file is data a reader can edit into any shape, so the layer each one
    // compiles to has to hold on every budget: an element the merged table gives a
    // field is drawn, and one it leaves bare stays the text it wraps.
    for (const name of library.names()) {
      for (const mode of MODES) {
        const overrides = toOverrides(parseSettings({ theme: name }), library)
        const theme = createTheme(mode, overrides)
        for (const token of TUI_TOKENS) {
          const spec = mergeTokenSpec(token, overrides.tokens, themeLayer(overrides))
          const drawn = theme.style(token, 'x') !== 'x'
          expect(drawn, `${name} in ${mode} draws ${token}`).toBe(mode !== 'none' && Object.keys(spec).length > 0)
        }
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
    expect(themed(BLUE).style('markdown.heading', 'x')).toContain('38;2;103;158;254')
  })

  it('leaves the semantic shades in the hues a reader already reads them in', () => {
    // A theme that repainted these would make every reader learn them again on
    // the one screen where reading them wrong costs the most.
    expect(themed(BLUE).style('tool.diff.added', 'x')).toContain('38;2;34;197;94')
    expect(themed(BLUE).style('tool.diff.removed', 'x')).toContain('38;2;242;90;90')
    expect(themed(BLUE).style('markdown.diagram.warning', 'x')).toContain('38;2;245;158;11')
  })

  it("gives a tool card the brand blue, over the table's own accent", () => {
    // The label is the loudest thing on the row, and it is loud in a colour of its
    // own: the warning shade belongs to the call that has not answered, so a table
    // that painted every label with it would have nothing left to say with it.
    expect(themed(BLUE).style('tool.title', 'x')).toContain('38;2;103;158;254')
    expect(untinted().style('tool.title', 'x')).toContain('38;2;95;175;215')
  })

  it('holds the bar a reader types into in the brand, where the product puts its send button', () => {
    expect(themed(BLUE).style('editor.border', 'x')).toContain('38;2;103;158;254')
  })

  it("sits the reader's own turn on the product's bubble fill", () => {
    // The product marks that turn with a background rather than a hue of its own,
    // so this is the one element the theme gives a band to.
    expect(themed(BLUE).style('transcript.user', 'x')).toContain('48;2;44;44;46')
    expect(untinted().style('transcript.user', 'x')).not.toContain('48;')
  })
})

describe('violet-orbit', () => {
  it('replaces the shipped accent family with its own violet', () => {
    const theme = themed(VIOLET)
    // status.prefix names the palette rather than a literal, so it proves the
    // palette half of the theme landed, not just the per-element half.
    expect(theme.style('status.prefix', 'x')).toContain('38;2;128;128;255')
    expect(theme.style('picker.border', 'x')).toContain('38;2;52;54;82')
    // The palette half is a file rather than a table in code, so the port's own
    // default shade is what a copy of this theme carries with it.
    expect(library.get(VIOLET)?.palette.default).toBe('#e8e9ff')
  })

  it('leaves a reader turn on the prompt shade alone, with no band behind it', () => {
    // The box is what separates a prompt from the prose around it, and a filled
    // row inside that box is a second treatment of the same fact: it reads as a
    // selected row rather than as the reader's own words.
    const style = themed(VIOLET).style('transcript.user', 'x')
    expect(style).toContain('38;2;240;241;255')
    expect(style).not.toContain('48;2;')
  })

  it('ships the current prompt, reply, and editor frame colours without settings overrides', () => {
    const theme = themed(VIOLET)
    expect(theme.style('transcript.user.border', 'x')).toContain('38;2;111;118;201')
    expect(theme.style('transcript.assistant.border', 'x')).toContain('38;2;168;151;113')
    expect(theme.editor.borderColor('x')).toContain('38;2;111;118;201')
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

  it('gives the skill name a violet the label does not wear', () => {
    // The name rides in the label's own row, so it needs a shade that separates
    // it from the periwinkle without dropping to the argument's dark slate.
    expect(themed(VIOLET).style('tool.skill', 'x')).toContain('38;2;201;163;217')
  })

  it('sinks a tool argument below the label beside it', () => {
    // The label and the argument share a row, and pi hands both jobs a mid-tone
    // blue from the same family; a reader scanning for the call cannot tell where
    // the name stops. Dropping the argument to a dark slate separates them on the
    // one axis a diff card has not already spent: a hue here would read as an
    // added line.
    const theme = themed(VIOLET)
    expect(theme.style('tool.args', 'x')).toContain('38;2;75;86;128')
    expect(theme.style('tool.subcall.args', 'x')).toContain('38;2;75;86;128')
  })

  it('merges a reader field over a themed element field by field', () => {
    // The two layers meet on one element: the reader naming one attribute must
    // not discard the shade the theme gave that same element.
    const theme = createTheme('truecolor', toOverrides(parseSettings({ theme: VIOLET, tokens: { 'tool.title': { bold: true } } }), library))
    expect(theme.style('tool.title', 'x')).toBe('\u001B[1;38;2;129;151;247mx\u001B[0m')
  })

  it('still lets the reader win on any element it set', () => {
    const theme = createTheme('truecolor', toOverrides(parseSettings({
      theme: VIOLET,
      tokens: { 'tool.title': { fg: '#ff0000' } },
    }), library))
    expect(theme.style('tool.title', 'x')).toContain('38;2;255;0;0')
  })
})
