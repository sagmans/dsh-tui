import { ACTION_CATALOG, actionLabel, keyName, keysFor, newShadows, type ActionLayer, type Keymap } from './input/actions.ts'

/** The layers a reader may ask for, in the order the table lists them. */
export const KEYMAP_LAYERS: readonly ActionLayer[] = ['prompt', 'surface', 'chord', 'gate', 'question', 'picker', 'library']

/** What each layer is for, so a list of ids reads as a surface rather than a dump. */
const LAYER_NOTES: Readonly<Record<ActionLayer, string>> = {
  prompt: 'the prompt bar',
  surface: 'the surface, answered before the editor',
  chord: 'the prefix first, then the key that follows it',
  gate: 'an approval',
  question: 'a question and its options',
  picker: 'a list',
  library: 'the editor and input pi-tui draws, read from the library',
}

/** Where the reader edits the section; the home is a variable, not a fixed path. */
const SETTINGS_HINT = 'edit $DSH_HOME/settings.yaml (default ~/.dsh/settings.yaml) under "dsh-tui:" · /keys shows the result'

/** The smallest document that says something, so the shape is never guessed at. */
const EXAMPLE = [
  'keys:',
  '  prompt.submit: ctrl+enter        # one key, or',
  '  prompt.newLine: [enter, shift+enter, ctrl+j]   # a list of them',
]

/** The layer a reader named, or nothing when the name is not one of them. */
export function keymapLayer(name: string): ActionLayer | undefined {
  return KEYMAP_LAYERS.find(layer => layer === name)
}

/**
 * The effective map, one line per action.
 *
 * The id comes first because it is what the reader types into settings.yaml;
 * the keys follow in the order they are read, so a list action answers its
 * first key before its second. A mark says which rows the reader wrote, because
 * a document that no longer matches the shipped map cannot be read off the file
 * once the file grows.
 */
export function renderKeymap(map: Keymap, only?: ActionLayer): string[] {
  const layers = only === undefined ? KEYMAP_LAYERS : [only]
  const actions = ACTION_CATALOG.filter(action => layers.includes(action.layer))
  const lines = [`keys · ${actions.length} actions · ${map.written.size} of them yours`, '']
  for (const layer of layers) {
    const rows = actions.filter(action => action.layer === layer)
    if (rows.length === 0) continue
    lines.push(`${layer} · ${LAYER_NOTES[layer]}:`)
    for (const action of rows) {
      const keys = keysFor(map, action.id).map(keyName).join(' · ')
      lines.push(`  ${action.id} = ${keys === '' ? 'unbound' : keys} · ${actionLabel(action.id)}${map.written.has(action.id) ? '  (yours)' : ''}`)
    }
    lines.push('')
  }
  const shadows = newShadows(map)
  if (shadows.length > 0) {
    lines.push('keys you took from the library:')
    for (const shadow of shadows) lines.push(`  ${keyName(shadow.key)}: ${shadow.winner} over ${shadow.loser}`)
    lines.push('')
  }
  lines.push(...EXAMPLE, '', SETTINGS_HINT)
  return lines
}
