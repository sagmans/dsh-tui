/**
 * The blank rows a part of the surface asks for, and the rule that keeps two
 * neighbours from drawing a break of their own each.
 *
 * Air belongs to the thing that asked for it: a card opens and closes with it, a
 * step of a turn opens with it, an overlay opens under it. What the reader asked
 * for is a break between two things rather than one per thing, so a seam keeps
 * the wider of the two requests instead of their sum — and a block placed on a
 * row that is already blank, or next to one, loses exactly the rows that would
 * have doubled it.
 */

/** How many rows the block opens with. */
function leadingBlanks(rows: readonly string[]): number {
  let count = 0
  while (count < rows.length && rows[count] === '') count += 1
  return count
}

/** How many rows the block closes with. */
function trailingBlanks(rows: readonly string[]): number {
  let count = 0
  while (count < rows.length && rows[rows.length - 1 - count] === '') count += 1
  return count
}

/**
 * Place one block under what is already drawn, and say how many rows it lost.
 *
 * The caller needs the count because anything it recorded about its own rows —
 * where a message drew, so a click can find it — is measured from the first row
 * that survived.
 */
export function placeGap(lines: string[], rows: readonly string[]): number {
  const dropped = Math.min(leadingBlanks(rows), trailingBlanks(lines))
  for (let index = dropped; index < rows.length; index++) lines.push(rows[index]!)
  return dropped
}

/** One blank row, unless the row above it is already blank. */
export function pushGap(lines: string[]): void {
  if (lines[lines.length - 1] !== '') lines.push('')
}

/** However many blank rows a setting asked for. */
export function gapRows(count: number): string[] {
  return Array.from({ length: Math.max(0, count) }, () => '')
}
