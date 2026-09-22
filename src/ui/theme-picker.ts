import { hintKeys, moveHint, type Keymap } from '../input/actions.ts'
import { DEFAULT_THEME, type LoadedTheme, type ThemeLibrary } from '../theme-files.ts'
import { ListPicker, type PickerHints, type PickerRow } from './picker.ts'

/**
 * The themes to choose from, the one in force first.
 *
 * The row under the cursor is what the screen is painting, so the list opens on
 * the theme already in use: a preview starting anywhere else would repaint the
 * surface the moment the reader asked to see the list, and the top row would name
 * a theme they are not looking at.
 */
function orderedThemes(library: ThemeLibrary, inUse: string): readonly LoadedTheme[] {
  const themes = library.list()
  return [
    ...themes.filter(theme => theme.name === inUse),
    ...themes.filter(theme => theme.name !== inUse),
  ]
}

/**
 * One theme as a row.
 *
 * The count is of the elements the file names, not of the elements it changes: a
 * theme writes out its whole table, and one that names fewer leaves the rest to
 * the table underneath — which is the difference between two files that their
 * names alone do not show.
 */
function describeTheme(theme: LoadedTheme, inUse: string): PickerRow {
  const elements = Object.keys(theme.tokens).length
  return {
    label: theme.name,
    description: [
      theme.builtin ? 'built into the package' : 'yours',
      `${elements} element${elements === 1 ? '' : 's'}`,
      theme.name === inUse ? 'in use' : undefined,
    ].filter(part => part !== undefined).join(' · '),
    // The card marks the row under the cursor, which the list decides.
    current: false,
  }
}

/** What the list says about its own keys, read per paint so a rebind lands. */
function themeHints(keys: () => Keymap): PickerHints {
  return {
    empty: () => `nothing matches · backspace to widen · ${hintKeys(keys(), 'picker.cancel')} cancel`,
    listed: () => `${moveHint(keys(), 'picker.up', 'picker.down')} preview · ${hintKeys(keys(), 'picker.confirm')} apply · ${hintKeys(keys(), 'picker.cancel')} cancel · type to filter`,
  }
}

/**
 * The themes on disk, chosen by key press.
 *
 * Choosing a theme is a comparison, and a name does not carry the shades it
 * stands for, so the row under the cursor is handed back as it moves: the caller
 * paints the surface with it and writes nothing, which is what makes the list
 * itself the preview. The library is re-read per paint, so a theme exported or
 * edited while the list is open appears in it without reopening.
 */
export class ThemePicker extends ListPicker<LoadedTheme> {
  constructor(
    library: () => ThemeLibrary,
    chosen: () => string | undefined,
    keys: () => Keymap,
    /** The theme to show, or undefined to show the one the document names again. */
    preview: (theme: LoadedTheme | undefined) => void,
  ) {
    // A document naming no theme is a surface drawing the package's own, so the
    // row the cursor starts on and the screen agree whichever way it was left.
    const inUse = (): string => chosen() ?? DEFAULT_THEME
    super(
      () => orderedThemes(library(), inUse()),
      () => `theme · ${library().list().length} available`,
      theme => theme.name,
      theme => describeTheme(theme, inUse()),
      theme => [theme.name, theme.builtin ? 'built into the package' : 'yours'].join(' '),
      themeHints(keys),
      keys,
      // Opened unfiltered: the reader asked for the list, not for a search.
      '',
      preview,
    )
  }
}
