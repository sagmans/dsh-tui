import type { PromptEntry } from '../agent/prompt-history.ts'
import { hintKeys, moveHint, type Keymap } from '../input/actions.ts'
import { ListPicker } from './picker.ts'

/** A prompt used exactly once reads as ordinary, so the count only starts at a repeat. */
const REUSED = 2

/** Runs of whitespace, including the newlines a multiline prompt folds on. */
const WHITESPACE = /\s+/gu

/** Fold a multiline prompt onto one row, so a label cannot push the card apart. */
function singleLine(text: string): string {
  return text.replace(WHITESPACE, ' ').trim()
}

/**
 * The reverse search over recorded prompts.
 *
 * A prompt is taken whole: the reader is looking for something they already
 * wrote, so the row and the value inserted are the same text. The draft seeds
 * the filter, which turns reverse search into "keep going from here" instead of
 * starting the list over.
 */
export class HistoryPicker extends ListPicker<PromptEntry> {
  constructor(entries: () => readonly PromptEntry[], draft: string, keys: () => Keymap) {
    super(
      entries,
      () => 'prompt history · ' + entries().length + ' recorded',
      entry => entry.text,
      entry => ({
        label: singleLine(entry.text),
        description: entry.useCount >= REUSED ? entry.useCount + ' uses' : undefined,
        // The card marks the row under the cursor, which the list decides.
        current: false,
      }),
      entry => entry.text,
      {
        empty: () => `nothing matches · backspace to widen · ${hintKeys(keys(), 'picker.cancel')} cancel`,
        listed: () => `${moveHint(keys(), 'picker.up', 'picker.down')} move · ${hintKeys(keys(), 'picker.confirm')} insert · ${hintKeys(keys(), 'picker.cancel')} cancel · type to filter`,
      },
      keys,
      draft,
    )
  }
}
