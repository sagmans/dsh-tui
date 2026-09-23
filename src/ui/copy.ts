import { sliceByColumn, visibleWidth } from '@earendil-works/pi-tui'
import type { FrameRow } from './frame.ts'

/**
 * Read a copied selection back out of the rows the surface drew.
 *
 * A terminal copies the screen, so a reader who drags across a message takes the
 * frame the surface drew around it as well: the sides, the padding between a side
 * and the words, and the rules above and below. None of that is the reader's text
 * and none of it was asked for, so a copy is read back through the account the
 * surface kept of its own drawing — a row it recognises gives up its text, a row
 * that is frame alone is dropped, and a line it cannot place is handed back
 * exactly as the terminal gave it. Copying is no place to be clever: the frame is
 * only ever removed, never rewritten, so the worst a copy can lose is the shape
 * the reader was trying to get rid of — and a selection that was nothing but frame
 * comes back as it read, because a copy is never emptied.
 */
export function cleanCopied(text: string, rows: readonly FrameRow[]): string {
  if (text === '' || rows.length === 0) return text
  const whole = byText(rows)
  const kept: string[] = []
  for (const line of text.split('\n')) {
    const read = readLine(line, rows, whole)
    // A rule is not a line of text: a selection that crossed one loses the row
    // rather than gaining an empty line where it stood.
    if (read !== undefined) kept.push(read)
  }
  // Every line was frame, so there was no text to keep. Handing the selection back
  // is the one answer that loses nothing: dropping it would clear a clipboard the
  // reader never asked to have cleared.
  return kept.length === 0 ? text : kept.join('\n')
}

/**
 * The rows a whole copied line can match, keyed by the text that line carries.
 *
 * A copy comes back trimmed, so a row that is all text matches on its trimmed
 * form. Built once per copy: a long transcript has one row per message line, and
 * reading each copied line against all of them would trim the whole transcript
 * again for every line the reader selected.
 */
function byText(rows: readonly FrameRow[]): ReadonlyMap<string, FrameRow> {
  const index = new Map<string, FrameRow>()
  for (const row of rows) {
    const text = row.drawn.trimEnd()
    // The first row wins, so the same line is read the same way twice.
    if (!index.has(text)) index.set(text, row)
  }
  return index
}

/** One copied line as the row it came from says it should read, or nothing when it came from the frame. */
function readLine(line: string, rows: readonly FrameRow[], whole: ReadonlyMap<string, FrameRow>): string | undefined {
  // A blank line is a blank line: no row of a frame reads as nothing, so there is
  // nothing here to recognise, and nothing to take away.
  if (line === '') return line
  const hit = locate(line, rows, whole)
  if (hit === undefined) return line
  const drawn = hit.row.drawn
  const frame = hit.row.frame
  if (frame === undefined) {
    // A rule is the frame itself: the reader selected the shape, not any text. The
    // whole row is that shape, and so is a piece of one that runs to either end —
    // which is what a drag across the frame leaves above and below a message. A
    // line that merely reads like the middle of a rule came from somewhere else,
    // and nothing here is entitled to take it away.
    if (hit.whole) return undefined
    const end = hit.column + visibleWidth(line)
    return hit.column === 0 || end >= visibleWidth(drawn) ? undefined : line
  }
  const own = sliceByColumn(drawn, frame.lead, Math.max(0, visibleWidth(drawn) - frame.lead - frame.trail))
  // A drag selects columns, so the first and last rows of a selection arrive as
  // fragments. Reading the fragment's own columns back out of the row it came from
  // is what takes the frame columns with it: the span the fragment spends inside the
  // frame is not part of the text this returns, and a fragment that spent all of
  // itself there was the shape and nothing more.
  const from = Math.max(hit.column, frame.lead)
  const to = Math.min(hit.column + visibleWidth(line), visibleWidth(drawn) - frame.trail)
  if (to <= from) return undefined
  return sliceByColumn(own, from - frame.lead, to - from, true).trimEnd()
}

/**
 * The row a copied line came from: the row that reads exactly as the line does,
 * or else the one row holding it as a fragment.
 */
function locate(line: string, rows: readonly FrameRow[], whole: ReadonlyMap<string, FrameRow>): Hit | undefined {
  const exact = whole.get(line)
  if (exact !== undefined) return { row: exact, column: 0, whole: true }
  for (const row of rows) {
    const offset = row.drawn.indexOf(line)
    if (offset === -1) continue
    // A fragment matches inside the row as it was drawn, which is where the frame's
    // own columns are still countable: the column it began at is measured in cells,
    // not characters, so a wide glyph before it costs the width it was drawn at.
    return { row, column: visibleWidth(row.drawn.slice(0, offset)), whole: false }
  }
  return undefined
}

/** One copied line placed in the row it matched. */
interface Hit {
  readonly row: FrameRow
  /** The column, in cells, where the line began inside that row. */
  readonly column: number
  /** Whether the line is the whole row rather than a piece of it. */
  readonly whole: boolean
}
