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
 * the reader was trying to get rid of.
 */
export function cleanCopied(text: string, rows: readonly FrameRow[]): string {
  if (text === '' || rows.length === 0) return text
  const kept: string[] = []
  for (const line of text.split('\n')) {
    const read = readLine(line, rows)
    // A rule is not a line of text: a selection that crossed one loses the row
    // rather than gaining an empty line where it stood.
    if (read !== undefined) kept.push(read)
  }
  return kept.join('\n')
}

/** One copied line as the row it came from says it should read, or nothing when it came from the frame. */
function readLine(line: string, rows: readonly FrameRow[]): string | undefined {
  // A blank line is a blank line: no row of a frame reads as nothing, so there is
  // nothing here to recognise, and nothing to take away.
  if (line === '') return line
  const hit = locate(line, rows)
  if (hit === undefined) return line
  const frame = hit.row.frame
  // A rule is the frame itself: the reader selected the shape, not any text.
  if (frame === undefined) return undefined
  const drawn = hit.row.drawn
  const own = sliceByColumn(drawn, frame.lead, Math.max(0, visibleWidth(drawn) - frame.lead - frame.trail))
  // A drag selects columns, so the first and last rows of a selection arrive as
  // fragments. Reading the fragment's own column back out of the row it came from
  // is what takes the frame columns with it: whatever part of the selection was
  // frame is simply not part of the text this returns.
  const column = visibleWidth(drawn.slice(0, hit.offset))
  const start = Math.max(0, column - frame.lead)
  const end = Math.min(visibleWidth(own), start + visibleWidth(line))
  return sliceByColumn(own, start, Math.max(0, end - start), true).trimEnd()
}

/**
 * The row a copied line came from: the row that reads exactly as the line does,
 * or else the one row holding it as a fragment.
 */
function locate(line: string, rows: readonly FrameRow[]): { readonly row: FrameRow; readonly offset: number } | undefined {
  // A copy comes back trimmed, so a row that is all text matches on its trimmed
  // form; a fragment matches inside the row as it was drawn, which is where the
  // frame's own columns are still countable.
  for (const row of rows) if (row.drawn.trimEnd() === line) return { row, offset: 0 }
  for (const row of rows) {
    const offset = row.drawn.indexOf(line)
    if (offset !== -1) return { row, offset }
  }
  return undefined
}
