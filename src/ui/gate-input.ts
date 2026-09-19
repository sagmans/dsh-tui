import { visibleWidth } from '@earendil-works/pi-tui'
import { BoxedEditor } from './editor.ts'

/** How a question's answer is shown while it is written. */
export type GateInputMode = 'answer' | 'secret'

/** One character of the mask, repeated to the width of what it hides. */
const MASKED = '*'

/** How much of a credential stays readable at each end, so its owner can recognize it. */
const MASK_HEAD = 4
const MASK_TAIL = 4

/**
 * A terminal sequence, so masking can tell a row's styling from its text: the
 * cursor is drawn as an escape around a character, and hiding the character
 * must not hide the mark that says where the cursor is.
 *
 * The string forms carry payloads a terminal reads rather than shows, and a
 * cursor marker is one of them: masking a marker's own text would replace the
 * position the terminal was told to place the cursor at with asterisks.
 */
const SEQUENCE = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|[\][P_^X][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/gu

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * One visible grapheme, and where it sits among the row's visible characters.
 *
 * Whitespace is not among them: the editor lays the answer out with spaces that
 * belong to its own drawing, and hiding them would move the text under the
 * cursor rather than hide it.
 */
function visibleAt(text: string): { segment: string; position: number }[] {
  const found: { segment: string; position: number }[] = []
  let position = 0
  for (const { segment } of GRAPHEMES.segment(text)) {
    if (segment.trim() === '') {
      found.push({ segment, position: -1 })
      continue
    }
    found.push({ segment, position })
    position += 1
  }
  return found
}

/**
 * Hide the middle of a credential and keep its ends readable.
 *
 * The reader is checking which key they pasted, and a row of asterisks answers
 * nothing; a bystander is not meant to read it either, so only the first and
 * last few characters survive. Rows are masked one at a time because that is
 * how the editor hands them over, and a credential is written on one line.
 */
function maskCredentialRow(row: string): string {
  const segments: { escape: boolean; text: string }[] = []
  let last = 0
  for (const match of row.matchAll(SEQUENCE)) {
    segments.push({ escape: false, text: row.slice(last, match.index) })
    segments.push({ escape: true, text: match[0] })
    last = match.index + match[0].length
  }
  segments.push({ escape: false, text: row.slice(last) })
  const visible = segments.filter(segment => !segment.escape).flatMap(segment => visibleAt(segment.text))
  const total = visible.reduce((count, entry) => count + (entry.position >= 0 ? 1 : 0), 0)
  if (total <= MASK_HEAD + MASK_TAIL) return row
  let seen = 0
  return segments.map((segment) => {
    if (segment.escape) return segment.text
    return visibleAt(segment.text).map((entry) => {
      if (entry.position < 0) return entry.segment
      const readable = seen < MASK_HEAD || seen >= total - MASK_TAIL
      seen += 1
      return readable ? entry.segment : MASKED.repeat(Math.max(1, visibleWidth(entry.segment)))
    }).join('')
  }).join('')
}

/**
 * The input bar a gate collects an answer with.
 *
 * It is the prompt bar's own component, so an answer is written with the
 * movement, deletion, undo, and paste that bar already has. Its mode decides
 * only how the answer is shown: a question that declares a credential is
 * answered in the same bar with the middle of the value hidden, never in a
 * second widget that would have to grow its own editing.
 */
export class GateInputBar extends BoxedEditor {
  private mode: GateInputMode = 'answer'

  /** Switch what the bar shows without changing a character of what it holds. */
  setMode(mode: GateInputMode): void {
    if (this.mode === mode) return
    this.mode = mode
    this.invalidate()
  }

  /** Hide a credential's middle while its owner still recognizes both ends. */
  protected override decorateText(row: string): string {
    return this.mode === 'secret' ? maskCredentialRow(row) : row
  }
}
