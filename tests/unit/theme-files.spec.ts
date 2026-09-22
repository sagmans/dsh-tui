import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_PALETTE, DEFAULT_TOKENS, PALETTE_NAMES, TUI_TOKENS } from '@/theme-tokens.ts'
import {
  builtinThemesDir,
  ensureThemesHome,
  exportTheme,
  loadThemes,
  MAX_THEME_FILE_BYTES,
  SHIPPED_THEME,
  themesHomeDir,
} from '@/theme-files.ts'

const created: string[] = []

/** A scratch directory of theme files, standing in for one side of the search path. */
function dirOf(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-themes-'))
  created.push(dir)
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  return dir
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A theme that moves one element, in the shape a reader would write. */
const THEME = `palette:
  accent: '#123456'
tokens:
  tool.title: { fg: accent }
`

describe('loading', () => {
  it('resolves a built-in and one of the reader\'s own by the same lookup', () => {
    const library = loadThemes(dirOf({ 'mine.yaml': THEME }), dirOf({ 'theirs.yaml': THEME }))
    // The package's first, then the reader's, with the shipped name always there.
    expect(library.names()).toEqual(['shipped', 'theirs', 'mine'])
    expect(library.get('theirs')?.builtin).toBe(true)
    expect(library.get('mine')?.builtin).toBe(false)
    expect(library.get('mine')?.tokens['tool.title']).toEqual({ fg: 'accent' })
    expect(library.get('mine')?.palette.accent).toBe('#123456')
  })

  it('leaves a partial theme legal, because a theme is a layer', () => {
    const library = loadThemes(dirOf({ 'mine.yaml': 'tokens:\n  tool.title: { bold: true }\n' }), dirOf())
    expect(library.get('mine')?.tokens).toEqual({ 'tool.title': { bold: true } })
    expect(library.problems()).toEqual([])
  })

  it('reads a .yml as well as a .yaml', () => {
    expect(loadThemes(dirOf({ 'mine.yml': THEME }), dirOf()).get('mine')?.tokens).toEqual({ 'tool.title': { fg: 'accent' } })
  })

  it('always resolves the shipped name, with or without a file behind it', () => {
    const library = loadThemes(dirOf(), dirOf())
    const shipped = library.get(SHIPPED_THEME)
    expect(shipped?.tokens).toEqual({})
    expect(shipped?.palette).toEqual({})
  })

  it('keeps the names it could read and reports the file it could not', () => {
    const library = loadThemes(dirOf({ 'mine.yaml': THEME, 'broken.yaml': 'tokens: [unclosed\n' }), dirOf())
    expect(library.names()).toContain('mine')
    expect(library.names()).not.toContain('broken')
    expect(library.problems().join('\n')).toContain('broken.yaml')
  })

  it('refuses an element the surface does not have, by name', () => {
    const library = loadThemes(dirOf({ 'mine.yaml': 'tokens:\n  tool.nope: { bold: true }\n' }), dirOf())
    expect(library.get('mine')).toBeUndefined()
    expect(library.problems().join('\n')).toContain('tool.nope')
  })

  it('refuses a palette entry the surface does not have, by name', () => {
    const library = loadThemes(dirOf({ 'mine.yaml': 'palette:\n  nope: \'#123456\'\n' }), dirOf())
    expect(library.problems().join('\n')).toContain('nope')
  })

  it('refuses a colour the surface cannot draw', () => {
    const library = loadThemes(dirOf({ 'mine.yaml': 'tokens:\n  tool.title: { fg: blue }\n' }), dirOf())
    expect(library.get('mine')).toBeUndefined()
    expect(library.problems().join('\n')).toContain('mine.yaml')
  })

  it('never hands a file larger than the cap to the parser', () => {
    const body = `tokens:\n  tool.title: { fg: '#123456' }\n# ${'x'.repeat(MAX_THEME_FILE_BYTES)}\n`
    const library = loadThemes(dirOf({ 'huge.yaml': body }), dirOf())
    expect(library.get('huge')).toBeUndefined()
    expect(library.problems().join('\n')).toContain('huge.yaml')
  })
})

describe('the names the package reserves', () => {
  it('keeps the built-in and ignores a file of the reader\'s that claims its name', () => {
    const library = loadThemes(dirOf({ 'theirs.yaml': 'tokens:\n  tool.title: { bold: true }\n' }), dirOf({ 'theirs.yaml': THEME }))
    expect(library.get('theirs')?.builtin).toBe(true)
    expect(library.get('theirs')?.tokens['tool.title']).toEqual({ fg: 'accent' })
  })

  it('names the file, the reserved name, and the rename that fixes it', () => {
    const library = loadThemes(dirOf({ 'theirs.yaml': THEME }), dirOf({ 'theirs.yaml': THEME }))
    const problems = library.problems().join('\n')
    expect(problems).toContain('theirs.yaml')
    expect(problems).toContain('built-in')
    expect(problems).toContain('rename')
  })

  it('uses the .yaml and reports the .yml it passed over', () => {
    const library = loadThemes(dirOf({ 'mine.yaml': THEME, 'mine.yml': 'tokens:\n  tool.title: { bold: true }\n' }), dirOf())
    expect(library.get('mine')?.tokens['tool.title']).toEqual({ fg: 'accent' })
    expect(library.problems().join('\n')).toContain('mine.yml')
  })
})

describe('the built-ins the package ships', () => {
  /** Every built-in, as the surface reads it, so a drift fails here and not on a screen. */
  const builtins = loadThemes(dirOf(), builtinThemesDir())

  it('draws violet-orbit with the shades the port brought over', () => {
    const violet = builtins.get('violet-orbit')
    expect(violet?.builtin).toBe(true)
    expect(violet?.tokens['tool.title']).toEqual({ fg: '#8197f7' })
    expect(violet?.palette.default).toBe('#e8e9ff')
  })

  it('names every element and every palette entry, so a copy is a full reference', () => {
    for (const theme of builtins.list()) {
      expect(Object.keys(theme.tokens).sort(), `${theme.name} elements`).toEqual([...TUI_TOKENS].sort())
      expect(Object.keys(theme.palette).sort(), `${theme.name} palette`).toEqual([...PALETTE_NAMES].sort())
    }
  })

  it('keeps shipped.yaml the code default table, value for value', () => {
    const shipped = builtins.get(SHIPPED_THEME)
    expect(shipped?.tokens).toEqual(DEFAULT_TOKENS)
    expect(shipped?.palette).toEqual(DEFAULT_PALETTE)
  })

  it('reads them without a complaint', () => {
    expect(builtins.problems()).toEqual([])
  })
})

describe('export', () => {
  it('writes the built-in out with a provenance line, numbered and never overwriting', () => {
    const home = dirOf()
    const builtin = dirOf({ 'theirs.yaml': THEME })
    const first = exportTheme(loadThemes(home, builtin), 'theirs')
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.select).toBe('theirs_export_1')
    expect(readFileSync(first.path, 'utf8')).toContain('fg: accent')
    const second = exportTheme(loadThemes(home, builtin), 'theirs')
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.path).not.toBe(first.path)
    expect(second.select).toBe('theirs_export_2')
  })

  it('says where the copy came from', () => {
    const result = exportTheme(loadThemes(dirOf(), dirOf({ 'theirs.yaml': THEME })), 'theirs')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(readFileSync(result.path, 'utf8').split('\n')[0]).toMatch(/^# exported from theirs/u)
  })

  it('refuses a name the package does not ship', () => {
    const result = exportTheme(loadThemes(dirOf(), dirOf()), 'nope')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem).toContain('nope')
  })

  it('refuses a theme the reader already owns, pointing at the file', () => {
    const home = dirOf({ 'mine.yaml': THEME })
    const result = exportTheme(loadThemes(home, dirOf({ 'theirs.yaml': THEME })), 'mine')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem).toContain('mine.yaml')
  })
})

describe('the reader\'s directory', () => {
  it('is created when it is missing, so an export has somewhere to land', () => {
    const missing = join(dirOf(), 'themes')
    expect(ensureThemesHome(missing)).toEqual([])
    expect(loadThemes(missing, dirOf()).names()).toEqual([SHIPPED_THEME])
  })

  it('sits under the harness home the environment names', () => {
    expect(themesHomeDir({ DSH_HOME: '/scratch/dsh' }, '/home/me')).toBe('/scratch/dsh/themes')
    expect(themesHomeDir({}, '/home/me')).toBe('/home/me/.dsh/themes')
  })
})
