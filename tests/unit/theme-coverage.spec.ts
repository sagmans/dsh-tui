import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { builtinThemesDir, loadThemes } from '@/theme-files.ts'
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
    for (const token of TUI_TOKENS) {
      expect(lines.some(line => line.includes(token)), `${token} missing from /theme`).toBe(true)
    }
    expect(lines.some(line => line.includes('transcript.user') && line.includes('#ff0000') && line.includes('override'))).toBe(true)
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
    expect(renderThemeTable(toOverrides(parseSettings({ theme: 'violet-orbit' }), library), library)[0]).toContain('violet-orbit')
    expect(renderThemeTable(toOverrides(parseSettings({}), library), library)[0]).not.toContain('violet-orbit')
  })

  it('reports a themed element as the theme, not as the reader', () => {
    // The whole point of the table is telling the reader which layer won, and
    // the file to edit differs: a theme row is not something they wrote.
    const lines = renderThemeTable(toOverrides(parseSettings({ theme: 'violet-orbit' }), library), library)
    const title = lines.filter(line => line.includes('tool.title'))
    expect(title).toHaveLength(1)
    expect(title[0]).toContain('#8197f7')
    expect(title[0]).toContain('(theme)')
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
  })
})
