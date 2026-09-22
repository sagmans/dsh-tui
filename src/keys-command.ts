import { ACTION_CATALOG, actionLabel, keyName, keysFor, newShadows, type ActionLayer, type Keymap } from './input/actions.ts'

/** The layers a reader may ask for, in the order the table lists them. */
export const KEYMAP_LAYERS: readonly ActionLayer[] = ['prompt', 'surface', 'chord', 'gate', 'question', 'picker', 'library']

/** What each layer is for, so a list narrowed to one reads as a surface rather than a dump. */
const LAYER_NOTES: Readonly<Record<ActionLayer, string>> = {
  prompt: 'the prompt bar',
  surface: 'the surface, answered before the editor',
  chord: 'the prefix first, then the key that follows it',
  gate: 'an approval',
  question: 'a question and its options',
  picker: 'a list',
  library: 'the editor and input pi-tui draws, read from the library',
}

/** The mark a row carries when the reader wrote it, so the shipped map and theirs never blur. */
const WRITTEN_MARK = '  (yours)'

/** What a row says instead of a layer when it names a key the reader took from the library. */
const TAKEN_GROUP = 'from the library'

/** The layer a reader named, or nothing when the name is not one of them. */
export function keymapLayer(name: string): ActionLayer | undefined {
  return KEYMAP_LAYERS.find(layer => layer === name)
}

/** What one layer is for, so a list narrowed to it can say what the reader is looking at. */
export function layerNote(layer: ActionLayer): string {
  return LAYER_NOTES[layer]
}

/** One row of the key map, as the list shows it. */
export interface KeymapRow {
  /** The action id, or the shadow's own name; what a pick would settle on. */
  readonly id: string
  /** The row as it reads: the id, the keys in force, and what the action does. */
  readonly label: string
  /** The part of the map the row belongs to: a layer, or the keys taken from the library. */
  readonly group: string
  /** Whether the reader wrote this row, which the list's heading counts. */
  readonly written: boolean
  /** Whether the row names an action rather than a key the map took from the library. */
  readonly action: boolean
}

/**
 * The effective map, one row per action.
 *
 * The id comes first because it is what the reader types into settings.yaml;
 * the keys follow in the order they are read, so a list action answers its
 * first key before its second. A mark says which rows the reader wrote, because
 * a document that no longer matches the shipped map cannot be read off the file
 * once the file grows. The keys the reader took from the library are rows too:
 * they are a fact about the map, and whoever remapped is the one reading it.
 */
export function keymapRows(map: Keymap, only?: ActionLayer): readonly KeymapRow[] {
  const layers = only === undefined ? KEYMAP_LAYERS : [only]
  const rows: KeymapRow[] = []
  for (const action of ACTION_CATALOG) {
    if (!layers.includes(action.layer)) continue
    const keys = keysFor(map, action.id).map(keyName).join(' · ')
    const written = map.written.has(action.id)
    rows.push({
      id: action.id,
      label: `${action.id} = ${keys === '' ? 'unbound' : keys} · ${actionLabel(action.id)}${written ? WRITTEN_MARK : ''}`,
      group: action.layer,
      written,
      action: true,
    })
  }
  for (const shadow of newShadows(map)) {
    rows.push({
      id: `shadow:${shadow.key}:${shadow.winner}`,
      label: `${keyName(shadow.key)}: ${shadow.winner} over ${shadow.loser}`,
      group: TAKEN_GROUP,
      written: false,
      action: false,
    })
  }
  return rows
}
