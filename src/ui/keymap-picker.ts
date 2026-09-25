import { hintKeys, moveHint, type Keymap } from '../input/actions.ts'
import { type ActionLayer } from '../input/action-catalog.ts'
import { keymapRows, layerNote, type KeymapRow } from '../keys-command.ts'
import { ListPicker } from './picker.ts'

/**
 * The list's heading: how much of the map is shown, and how much of it is the
 * reader's own.
 *
 * Read per paint rather than built once, because a settings edit made while the
 * list is open moves both counts under the reader's eyes.
 */
function heading(map: Keymap, layer: ActionLayer | undefined): string {
  const rows = keymapRows(map, layer)
  const actions = rows.filter(row => row.action).length
  const written = rows.filter(row => row.written).length
  const scope = layer === undefined ? '' : ` · ${layer} · ${layerNote(layer)}`
  return `keys${scope} · ${actions} actions · ${written} of them yours`
}

/**
 * The key map, as a list the reader narrows by typing.
 *
 * One surface's whole keyboard is too long to read as prose, so it is a list:
 * the filter reaches the action id, the layer, and the row's own words, which
 * is what makes "ctrl+o", "gate", and "stash" each find their rows. The rows
 * are re-read on every key and paint, so a settings edit lands in the open list
 * rather than behind it.
 */
export class KeymapPicker extends ListPicker<KeymapRow> {
  constructor(map: () => Keymap, layer: ActionLayer | undefined) {
    super(
      () => keymapRows(map(), layer),
      () => heading(map(), layer),
      row => row.id,
      row => ({ label: row.label, description: row.group, current: false }),
      row => [row.id, row.group, row.label].join(' '),
      {
        empty: () => `nothing matches · backspace to widen · ${hintKeys(map(), 'picker.cancel')} close`,
        // Nothing here is a pick, so both keys that settle the list close it;
        // naming each one keeps a remapped cancel key visible where it answers.
        listed: () =>
          `${moveHint(map(), 'picker.up', 'picker.down')} move · ${hintKeys(map(), 'picker.confirm')} close`
          + ` · ${hintKeys(map(), 'picker.cancel')} close · type to filter`,
      },
      // The map the list draws and the map its own keys are read from are the
      // same document, so a reader who moves picker.cancel sees both follow.
      map,
    )
  }
}
