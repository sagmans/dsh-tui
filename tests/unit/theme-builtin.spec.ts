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

/** The shipped table again, anchored on the cyan its accent is. */
const DRIFT = 'polar-drift'

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

  it('renders each shipped theme across terminal colour budgets', () => {
    const expected = {
      truecolor: /^\u001b\[38;2;\d+;\d+;\d+mx\u001b\[0m$/,
      '256': /^\u001b\[38;5;\d+mx\u001b\[0m$/,
      '16': /^\u001b\[(?:3[0-7]|9[0-7])mx\u001b\[0m$/,
      none: /^x$/,
    }
    for (const name of library.names()) {
      const overrides = toOverrides(parseSettings({ theme: name }), library)
      for (const mode of MODES) {
        const theme = createTheme(mode, overrides)
        for (const token of TUI_TOKENS) {
          expect(theme.visible(token), `${name} hides ${token} in ${mode}`).toBe(true)
          expect(theme.glyph(token), `${name} changes ${token} glyph in ${mode}`).toBe('')
          const styled = theme.style(token, 'x')
          expect(styled, `${name} cannot render ${token} in ${mode}`).toContain('x')
          // A configured element must reach the renderer, even when this theme inherits its shade.
          const spec = mergeTokenSpec(token, overrides.tokens, themeLayer(overrides))
          expect(styled !== 'x', `${name} loses ${token} styling in ${mode}`).toBe(mode !== 'none' && Object.keys(spec).length > 0)
        }
        expect(theme.style('tool.title', 'x'), `${name} in ${mode}`).toMatch(expected[mode])
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

  it("leaves the reader's own turn on a plain row inside its frame", () => {
    // The product fills that row, and this surface frames it already: a band
    // inside the frame says one fact twice and reads as a selected row.
    const style = themed(BLUE).style('transcript.user', 'x')
    expect(style).toContain('38;2;249;250;251')
    expect(style).not.toContain('48;2;')
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

describe('polar-drift', () => {
  it('paints the anchor on the elements that carry the accent', () => {
    // The anchor is the whole point of the theme, so it has to land on what a
    // reader looks at rather than sit in the file as a shade nothing names.
    const theme = themed(DRIFT)
    expect(theme.style('markdown.heading', 'x')).toContain('38;2;39;207;245')
    expect(theme.style('markdown.link', 'x')).toContain('38;2;39;207;245')
    expect(theme.editor.borderColor('x')).toContain('38;2;39;207;245')
  })

  it('tints the neutrals through the anchor rather than shipping them grey', () => {
    // An element naming no literal still follows the tint, and the argument is
    // where a reader compares two shades side by side on one row.
    const theme = themed(DRIFT)
    expect(theme.style('transcript.reasoning.body', 'x')).toContain('38;2;142;172;177')
    expect(theme.style('tool.args', 'x')).toContain('38;2;185;221;229')
    expect(library.get(DRIFT)?.palette.accent).toBe('#27CFF5')
  })

  it('leaves the semantic shades in the hues a reader already reads them in', () => {
    // Randomising these would cost a reader the one thing the surface cannot
    // draw twice: a second reading of what changed.
    const theme = themed(DRIFT)
    expect(theme.style('markdown.diff.added', 'x')).toContain('38;2;41;217;106')
    expect(theme.style('markdown.diff.removed', 'x')).toContain('38;2;227;80;72')
    expect(theme.style('markdown.diagram.warning', 'x')).toContain('38;2;250;186;66')
  })

  it('keeps the reader turn a plain row rather than a band of the anchor hue', () => {
    // A filled row inside the prompt's own frame reads as a selected row, which
    // is the one thing that row must not look like.
    const style = themed(DRIFT).style('transcript.user', 'x')
    expect(style).toContain('38;2;244;245;246')
    expect(style).not.toContain('48;2;')
  })
})
