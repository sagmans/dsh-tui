import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_THEME, builtinThemesDir, loadThemes } from '@/theme-files.ts'
import { DEFAULT_PALETTE, DEFAULT_TOKENS } from '@/theme-defaults.ts'
import { resolveToken } from '@/theme-resolver.ts'
import { TUI_TOKENS, type TuiToken } from '@/theme-tokens.ts'
import { createTheme } from '@/theme.ts'
import { parseSettings, toOverrides } from '@/theme-settings.ts'
import { renderThemeTable } from '@/theme-command.ts'
import { builtinLibrary } from '../support/themes.ts'

/** The package's themes, which is what a name in a section resolves against. */
const library = builtinLibrary()

const created: string[] = []

/** A scratch directory of theme files, standing in for one side of the search path. */
function dirOf(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-theme-coverage-'))
  created.push(dir)
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  return dir
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Every capability the surface can meet, so no token is only tested in one. */
const MODES = ['truecolor', '256', '16', 'none'] as const

describe('token coverage', () => {
  it('emits nothing at all when colour is off, for every token', () => {
    // The NO_COLOR contract is all-or-nothing: one token emitting an attribute
    // would mean a reader who asked for no styling still got some.
    for (const token of TUI_TOKENS) {
      const style = resolveToken(token, new Map(), DEFAULT_PALETTE, 'none')
      expect(style.prefix, `${token} styled with colour off`).toBe('')
      expect(style.suffix, `${token} reset with colour off`).toBe('')
    }
  })

  it('paints shipped accents at each terminal colour budget without styling plain code', () => {
    const expected = {
      truecolor: /^\u001b\[38;2;95;175;215mx\u001b\[0m$/,
      '256': /^\u001b\[38;5;\d+mx\u001b\[0m$/,
      '16': /^\u001b\[(?:3[0-7]|9[0-7])mx\u001b\[0m$/,
      none: /^x$/,
    }
    for (const mode of MODES) {
      const theme = createTheme(mode)
      for (const token of TUI_TOKENS) {
        expect(DEFAULT_TOKENS[token], `${token} has no shipped default`).toBeDefined()
        expect(theme.visible(token), `${token} is invisible in ${mode}`).toBe(true)
        expect(theme.glyph(token), `${token} ships a glyph in ${mode}`).toBe('')
        // Every styled default must survive the compiled theme, not only the pinned accent.
        expect(theme.style(token, 'x') !== 'x', `${token} loses styling in ${mode}`).toBe(
          mode !== 'none' && Object.keys(DEFAULT_TOKENS[token]).length > 0,
        )
      }
      expect(theme.style('tool.title', 'x')).toMatch(expected[mode])
      expect(theme.style('markdown.codeBlock', 'x')).toBe('x')
    }
  })

  it('applies an override to every token', () => {
    // A token a reader cannot change is not customizable, whatever the table
    // says; this drives each one through an override and requires an effect.
    for (const token of TUI_TOKENS) {
      const settings = parseSettings({ tokens: { [token]: { fg: '#ff00ff', bold: true } } })
      const theme = createTheme('truecolor', toOverrides(settings, library))
      const styled = theme.style(token as TuiToken, 'x')
      expect(styled, `${token} ignored its override`).toContain('38;2;255;0;255')
    }
  })

  it('lets every token be hidden', () => {
    for (const token of TUI_TOKENS) {
      const settings = parseSettings({ tokens: { [token]: { hidden: true } } })
      const theme = createTheme('truecolor', toOverrides(settings, library))
      expect(theme.visible(token as TuiToken), `${token} cannot be hidden`).toBe(false)
    }
  })
})

describe('/theme', () => {
  it('lists every element with the value in force and where it came from', () => {
    const overrides = toOverrides(parseSettings({ tokens: { 'transcript.user': { fg: '#ff0000' } } }), library)
    const lines = renderThemeTable(overrides, library)
    const rows = lines.filter(line => line.startsWith('  ') && line.includes(' = '))
    expect(rows.map(line => line.slice(2, line.indexOf(' = ')))).toEqual(TUI_TOKENS)
    expect(rows).toContain('  transcript.user = #ff0000 (override)')
  })

  it('tells an element a theme wrote from one only the palette reaches', () => {
    // A theme is a layer, so an element it says nothing about keeps the compiled
    // spec, which names a palette entry rather than a shade. The two answer
    // differently because the file to edit differs: the theme's, or one palette
    // line — and the package's own themes name every element, so only a theme with
    // holes in it can still show the difference.
    const partial = loadThemes(
      dirOf({ 'partial.yaml': 'tokens:\n  tool.title: { fg: accent }\n' }),
      builtinThemesDir(),
    )
    const lines = renderThemeTable(toOverrides(parseSettings({ theme: 'partial' }), partial), partial)
    expect(lines.some(line => line.includes('tool.title') && line.includes('(theme)'))).toBe(true)
    expect(lines.some(line => line.includes('transcript.reasoning.body') && line.includes('(palette)'))).toBe(true)
  })

  it('names the theme in force, so the reader knows what they are looking at', () => {
    // An unnamed section is not a bare table: the package's own theme draws it,
    // and the heading has to say which one rather than leave the reader guessing
    // at a look nothing named.
    expect(renderThemeTable(toOverrides(parseSettings({ theme: 'violet-orbit' }), library), library)[0]).toContain('violet-orbit')
    expect(renderThemeTable(toOverrides(parseSettings({}), library), library)[0]).toContain(DEFAULT_THEME)
  })

  it('names the file the reader edits, from the host that owns the path', () => {
    // The reader cannot find this path alone: the write lands in the profile's own
    // patch, which is neither beside the package nor at the file older releases
    // read, so a footer naming the wrong file is one they edit in vain.
    const lines = renderThemeTable(toOverrides(parseSettings({}), library), library, {
      kind: 'document', path: '/home/dev/.dsh/profiles/tui/cordis.patch.yml',
    })
    expect(lines.at(-1)).toContain('/home/dev/.dsh/profiles/tui/cordis.patch.yml')
    expect(lines.at(-1)).toContain("under this row's config")
  })

  it('keeps the section file for a section host and names no file without an owner', () => {
    // Both other shapes are answers about where the reader edits: one host reads a
    // `dsh-tui:` section, and a host with no owner has no file to point at, so that
    // line says what the command does instead of naming a path nothing writes.
    const section = renderThemeTable(toOverrides(parseSettings({}), library), library, { kind: 'section' })
    expect(section.at(-1)).toContain('$DSH_HOME/settings.yaml')
    const unknown = renderThemeTable(toOverrides(parseSettings({}), library), library, { kind: 'unknown' })
    expect(unknown.at(-1)).not.toContain('settings.yaml')
    expect(renderThemeTable(toOverrides(parseSettings({}), library), library).at(-1)).not.toContain('settings.yaml')
  })

  it('tells the reader which of the two files a row came from', () => {
    // A complete theme names every element, so the origin column is what says
    // which file to open: the theme's copy, or the line the reader wrote. An
    // element no theme names at all is reported as the palette, which the theme
    // with holes above covers.
    const lines = renderThemeTable(toOverrides(parseSettings({
      theme: 'violet-orbit',
      tokens: { 'status.cwd': { fg: '#ff00ff' } },
    }), library), library)
    expect(lines.some(line => line.includes('transcript.reasoning.body') && line.includes('(theme)'))).toBe(true)
    expect(lines.some(line => line.includes('status.cwd') && line.includes('(override)'))).toBe(true)
    // One row per element, carrying the shade the theme gave it: a second row
    // would read as a second answer to which layer won.
    const title = lines.filter(line => line.includes('tool.title'))
    expect(title).toHaveLength(1)
    expect(title[0]).toContain('#8197f7')
  })
})
