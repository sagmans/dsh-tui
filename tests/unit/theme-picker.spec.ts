import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultKeymap } from '@/input/actions.ts'
import { DEFAULT_THEME, loadThemes, type LoadedTheme, type ThemeLibrary } from '@/theme-files.ts'
import { ThemePicker } from '@/ui/theme-picker.ts'

const created: string[] = []

/** A scratch directory of theme files, standing in for one side of the search path. */
function dirOf(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-theme-picker-'))
  created.push(dir)
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  return dir
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * The themes a case lists.
 *
 * Built from files rather than from hand-built rows, because what the list says
 * about a theme — where it came from, how much of the table it writes — is what
 * the loader decided when it read one.
 */
const libraryOf = (own: Record<string, string>, builtin: Record<string, string>): ThemeLibrary =>
  loadThemes(dirOf(own), dirOf(builtin))

/** A theme naming the elements it moves, in the shape a reader would write. */
const bodyOf = (...elements: string[]): string =>
  `tokens:\n${elements.map(element => `  ${element}: { fg: accent }`).join('\n')}\n`

const picker = (
  library: ThemeLibrary,
  chosen: string | undefined = undefined,
  preview: (theme: LoadedTheme | undefined) => void = () => {},
): ThemePicker => new ThemePicker(() => library, () => chosen, defaultKeymap, preview)

/**
 * Three built-ins and one of the reader's own: enough to order a list and to label
 * its rows. The package's default is among them, because a document naming no
 * theme is drawn with it and the list is where that shows.
 */
const library = (): ThemeLibrary => libraryOf(
  { 'mine.yaml': bodyOf('tool.title') },
  {
    'one.yaml': bodyOf('tool.title', 'tool.args'),
    'two.yaml': bodyOf('tool.title'),
    [`${DEFAULT_THEME}.yaml`]: bodyOf('tool.title'),
  },
)

describe('ThemePicker rows', () => {
  it('names where a theme came from and how much of the table it writes', () => {
    const rows = new Map(picker(library()).card().rows.map(row => [row.label, row.description]))
    expect(rows.get('one')).toBe('built into the package · 2 elements')
    expect(rows.get('mine')).toBe('yours · 1 element')
  })

  it('leads with the theme in force, so opening the list repaints nothing', () => {
    const card = picker(library(), 'mine').card()
    const labels = card.rows.map(row => row.label)
    // The order the rest keep is the loader's, which this list does not own.
    expect(labels[0]).toBe('mine')
    expect([...labels].sort()).toEqual([DEFAULT_THEME, 'mine', 'one', 'two'].sort())
    expect(card.rows[0]?.description).toContain('in use')
    expect(card.rows.filter(row => row.description?.includes('in use'))).toHaveLength(1)
  })

  it("reads a document that names no theme as the package's own being in use", () => {
    const card = picker(library(), undefined).card()
    expect(card.rows[0]?.label).toBe(DEFAULT_THEME)
    expect(card.rows[0]?.description).toContain('in use')
  })

  it('counts the list in its heading', () => {
    expect(picker(library()).card().title).toBe('theme · 4 available')
  })

  it('says the screen is previewing rather than only moving', () => {
    expect(picker(library()).card().hint).toContain('preview')
  })
})

describe('ThemePicker preview', () => {
  it('hands back the row under the cursor as it moves, and again when a filter widens', () => {
    const seen: (string | undefined)[] = []
    const moving = picker(library(), undefined, theme => seen.push(theme?.name))
    moving.handleKey('\u001b[B')
    moving.handleKey('\u007f')
    expect(seen).toEqual(['one', DEFAULT_THEME])
  })

  it('narrows to the name being typed and previews what is left', () => {
    const seen: (string | undefined)[] = []
    const moving = picker(library(), undefined, theme => seen.push(theme?.name))
    for (const character of 'mine') moving.handleKey(character)
    expect(moving.card().rows.map(row => row.label)).toEqual(['mine'])
    expect(seen.at(-1)).toBe('mine')
  })

  it('filters on where a theme came from as well as on its name', () => {
    const moving = picker(library())
    for (const character of 'yours') moving.handleKey(character)
    expect(moving.card().rows.map(row => row.label)).toEqual(['mine'])
  })

  it('hands back nothing when the filter leaves no theme to point at', () => {
    const seen: (string | undefined)[] = []
    const moving = picker(library(), undefined, theme => seen.push(theme?.name))
    moving.handleKey('z')
    expect(moving.card().rows).toHaveLength(0)
    expect(seen).toEqual([undefined])
  })

  it('settles on the name of the row it is on', () => {
    expect(picker(library(), 'mine').handleKey('\r')).toEqual({ kind: 'pick', id: 'mine' })
  })
})
