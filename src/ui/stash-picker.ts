import type { StashEntry } from '../stash/schema.ts'
import { hintKeys, moveHint, type Keymap } from '../input/actions.ts'
import { describeAge, ListPicker, type PickerHints, type PickerRow } from './picker.ts'

/** Longest draft label a list row shows before it is cut. */
const LABEL_LENGTH = 50
/** What a draft that contains only whitespace is called, so a row is never blank. */
const EMPTY_LABEL = '(empty draft)'
const ELLIPSIS = '…'

/**
 * What the list says about its own keys.
 *
 * Read from the map on every paint, because a settings edit lands while the list
 * is open and a hint that kept naming the shipped key would be wrong.
 */
function stashHints(keys: () => Keymap, verb: string): PickerHints {
  return {
    empty: () => `nothing matches · backspace to widen · ${hintKeys(keys(), 'picker.cancel')} cancel`,
    listed: () => `${moveHint(keys(), 'picker.up', 'picker.down')} move · ${hintKeys(keys(), 'picker.confirm')} ${verb} · ${hintKeys(keys(), 'picker.cancel')} cancel · type to filter`,
  }
}

/**
 * The first line of a draft, as one list row can show it.
 *
 * A picker row is a single line, so line feeds and runs of whitespace collapse;
 * a draft whose only line is blank still has to name itself.
 */
export function stashLabel(text: string): string {
  const line = text.split('\n').find(candidate => candidate.trim() !== '')?.trim().replace(/\s+/gu, ' ')
  if (line === undefined || line === '') return EMPTY_LABEL
  return line.length <= LABEL_LENGTH ? line : `${line.slice(0, LABEL_LENGTH - 1)}${ELLIPSIS}`
}

/**
 * The drafts of one working directory, chosen by key press.
 *
 * The id a pick settles on is the entry id, so a pop survives the list being
 * re-read while it is open and can never take the wrong draft after a concurrent
 * drop shifted the indexes.
 */
export class StashPicker extends ListPicker<StashEntry> {
  constructor(
    entries: readonly StashEntry[],
    cwdLabel: string,
    keys: () => Keymap,
    now: () => number = () => Date.now(),
  ) {
    super(
      () => entries,
      () => `stash · ${cwdLabel} · ${entries.length} draft${entries.length === 1 ? '' : 's'}`,
      entry => entry.id,
      (entry): PickerRow => ({
        label: stashLabel(entry.text),
        description: describeAge(entry.createdAt, now()),
        // The card marks the row under the cursor, which the list decides.
        current: false,
      }),
      entry => entry.text,
      stashHints(keys, 'pop'),
      keys,
    )
  }
}

/** The choice that clears the bank, as opposed to leaving it alone. */
export const STASH_CLEAR_CHOICE = 'clear'
const STASH_CANCEL_CHOICE = 'cancel'

interface ConfirmChoice {
  readonly id: string
  readonly label: string
  readonly description: string
}

/** Whether a settled confirm pick was the destructive one. */
export function confirmedClear(picked: string | undefined): boolean {
  return picked === STASH_CLEAR_CHOICE
}

/**
 * A two-row confirmation.
 *
 * Clearing a bank is irreversible, so it is answered by picking a row rather
 * than by a key that could be pressed by accident: leaving is the first row and
 * the safe default.
 */
export class StashConfirmPicker extends ListPicker<ConfirmChoice> {
  constructor(count: number, keys: () => Keymap) {
    const choices: readonly ConfirmChoice[] = [
      { id: STASH_CANCEL_CHOICE, label: 'cancel', description: 'keep every draft' },
      {
        id: STASH_CLEAR_CHOICE,
        label: `delete ${count} draft${count === 1 ? '' : 's'}`,
        description: 'remove them permanently',
      },
    ]
    super(
      () => choices,
      () => `clear stash · ${count} draft${count === 1 ? '' : 's'} in this directory`,
      choice => choice.id,
      (choice): PickerRow => ({ label: choice.label, description: choice.description, current: false }),
      choice => choice.label,
      stashHints(keys, 'confirm'),
      keys,
    )
  }
}
