import { visibleWidth } from '@earendil-works/pi-tui'
import { BoxedEditor } from './editor.ts'

/** What the bar shows a reader while they type into it. */
export type GateInputMode = 'answer' | 'secret'

/** One character of the mask, repeated to the width of what it hides. */
const MASKED = '*'

/**
 * A terminal sequence, so masking can tell the styling of a row from its text:
 * a cursor or a highlight is drawn as an escape around a character, and hiding
 * the character must not hide the mark that says where the cursor is.
 *
 * The string forms carry payloads a terminal reads rather than shows, and the
 * cursor marker is one of them: masking a marker's own text replaces the
 * position the terminal was told to place the cursor at with asterisks.
 */
const SEQUENCE = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|[\][P_^X][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/gu

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** The mask that stands in for a run of text, as wide as the text it hides. */
function maskText(text: string): string {
  return [...GRAPHEMES.segment(text)]
    .map(({ segment }) => (segment.trim() === '' ? segment : MASKED.repeat(Math.max(1, visibleWidth(segment)))))
    .join('')
}

/** Hide every visible character of a rendered row, leaving its escapes alone. */
function maskedRow(row: string): string {
  let result = ''
  let last = 0
  for (const match of row.matchAll(SEQUENCE)) {
    result += maskText(row.slice(last, match.index))
    result += match[0]
    last = match.index + match[0].length
  }
  return result + maskText(row.slice(last))
}

/**
 * The input bar a gate collects an answer with.
 *
 * It is the prompt bar's own component, so an answer is written with the
 * movement, deletion, undo, and paste that bar already has. Its modes decide
 * only how the answer is shown: a question that asks for a credential is
 * answered in the same bar with the text hidden, never in a second widget that
 * would have to grow its own editing.
 */
export class GateInputBar extends BoxedEditor {
  private mode: GateInputMode = 'answer'

  /** Switch what the bar shows without changing a character of what it holds. */
  setMode(mode: GateInputMode): void {
    if (this.mode === mode) return
    this.mode = mode
    this.invalidate()
  }

  /** Hide what a secret question collects, keeping every row's own width. */
  protected override decorateText(row: string): string {
    return this.mode === 'secret' ? maskedRow(row) : row
  }
}
