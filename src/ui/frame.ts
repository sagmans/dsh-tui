import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import { renderTerminalText } from '../terminal-text.ts'

/**
 * The two shapes the surface closes a block into, and the glyphs a box needs.
 *
 * A bar the reader types in is a box: its sides and its padding are what say
 * "type here", and nothing is ever read back out of it. A block already written
 * is a band, which draws a marked rule above and below it, air outside each,
 * and nothing beside it, so a copy of one row is the row itself rather than the
 * frame that held it and a diagram keeps every column the terminal gave it. Both
 * shapes take the same
 * faces and close on the same rule; which one a row lands in is how the surface
 * says whether it is still open for editing or is already history.
 */
export const FRAME_GLYPHS = { topLeft: '╭', topRight: '╮', bottomLeft: '╰', bottomRight: '╯', side: '│' } as const

/** A box costs one column each side, so the text wraps that much narrower. */
export const FRAME_COLUMNS = 2
/** One column of air inside a box, so a full line never touches the border. */
export const PADDING_X = 1
/** A box needs both edges, both paddings, and one column left to type in. */
export const MIN_BOX_WIDTH = FRAME_COLUMNS + PADDING_X * 2 + 1

/** The columns the text of a bar owns, given the width of everything inside its frame. */
export function textWidth(innerWidth: number): number {
  return Math.max(1, innerWidth - PADDING_X * 2)
}

/** One text row of a bar: the air, the text, and the rest of the inside width. */
export function textRow(text: string, innerWidth: number): string {
  const width = Math.max(0, innerWidth)
  const room = Math.max(0, textWidth(width) - visibleWidth(text))
  const row = `${' '.repeat(PADDING_X)}${text}${' '.repeat(room)}${' '.repeat(PADDING_X)}`
  // A bar can be narrower than its own padding. The frame's columns are the only
  // thing allowed to own the edge, so a row that would overflow is cut here,
  // where the bar can still count what it lost, instead of by the terminal.
  return visibleWidth(row) <= width ? row : truncateToWidth(row, width, '')
}

/**
 * The rule that closes a bar, naming what the bar could not fit.
 *
 * A hidden count is a fact about the text, not extra text, so it rides the rule
 * the way the editor's own scroll indicator does: the same label in the same
 * place, at the same width, so both bars report a fold identically.
 */
export function frameRule(innerWidth: number, hiddenRows: number): string {
  const width = Math.max(0, innerWidth)
  if (hiddenRows <= 0) return '─'.repeat(width)
  const label = ` ↓ ${hiddenRows} more `
  const labelWidth = visibleWidth(label)
  if (labelWidth + 2 <= width) {
    const left = Math.floor((width - labelWidth) / 2)
    return `${'─'.repeat(left)}${label}${'─'.repeat(width - left - labelWidth)}`
  }
  // Too narrow for a centred label: name it as far as it fits instead of
  // dropping the fact. Both the label and the fallback are ASCII, so slicing by
  // character is slicing by column here.
  const indicator = `─── ↓ ${hiddenRows} more `
  if (visibleWidth(indicator) <= width) return indicator + '─'.repeat(width - visibleWidth(indicator))
  const ellipsis = '...'.slice(0, width)
  return indicator.slice(0, Math.max(0, width - ellipsis.length)) + ellipsis
}

/**
 * The marks a band closes its rules with, by the end of the block they close.
 *
 * A band draws no sides, so these two columns are the whole of what tells a block
 * that has ended from one that has begun: two blocks drawn back to back would
 * otherwise read as a single fence around whatever sat between them. Quadrant arcs
 * rather than the arcs a box closes with, and detached from the rule instead of
 * joined to it: an arc that meets the rule is read as a corner, and a corner
 * promises the sides and the padding only a box has. Detached, the arc sits over
 * the rule that opens a block and under the rule that closes it, out where the air
 * is, so the rule runs unbroken to its own end and nothing is left inside the shape
 * but the words. The pair on the opening rule lifts and the pair on the closing
 * rule drops, so an ended block cannot be read as a begun one. One column each, by
 * the count the rows themselves are measured with.
 */
const BAND_MARKS = {
  open: { left: '◜', right: '◝' },
  close: { left: '◟', right: '◞' },
} as const

/**
 * The row of air a band leaves outside each of its rules.
 *
 * Inside the rules there is nothing but the message: the first row of it sits
 * against the rule that opened the block, so no part of the shape asks for padding
 * the text does not have. The air belongs outside instead, where its work is to
 * separate one block from the next rather than to hold a message off its own rule,
 * and it is a row of its own rather than a margin on the text, because every row of
 * the text has to stay exactly as the block drew it: a reader who takes one back
 * out gets the words, never the space that framed them.
 */
const BAND_AIR = ''

/** One end of a band: the marks, and the rule that runs between them. */
function bandRule(width: number, hiddenRows: number, marks: { readonly left: string; readonly right: string }, faces: BandFaces): string {
  // Both marks or neither: a partial pair would overrun a narrow terminal.
  if (width < FRAME_COLUMNS) return faces.border(frameRule(width, hiddenRows))
  const rule = frameRule(width - FRAME_COLUMNS, hiddenRows)
  if (faces.mark === undefined) return faces.border(`${marks.left}${rule}${marks.right}`)
  // Separate style runs keep the rule's reset from swallowing the right mark.
  return `${faces.mark(marks.left)}${faces.border(rule)}${faces.mark(marks.right)}`
}

/** How one block of text paints itself inside the shape that carries it. */
export interface FrameFaces {
  /** Paints one row of the block's own text. */
  readonly text: (line: string) => string
  /** Paints the rules, and the sides and corners when the shape is a box. */
  readonly border: (rule: string) => string
  /**
   * Whether the frame is drawn at all.
   *
   * A border the reader has hidden asks for none, and so does a bar with no room
   * left beside its own furniture: either way the rows stay and the frame around
   * them does not.
   */
  readonly drawn: boolean
}

/** A band can accent the marks at its ends without changing the editor's box styling. */
export interface BandFaces extends FrameFaces {
  /** Optional so callers without accents retain their existing border paint. */
  readonly mark?: (glyph: string) => string
}

/** Whether a bar has the width, and the visible border, to close a box. */
export function canFrame(width: number, borderVisible: boolean): boolean {
  return borderVisible && width >= MIN_BOX_WIDTH
}

/**
 * One block of already-rendered rows as a box draws it: padded to the frame's
 * own text width, and closed into it when the box can be drawn.
 *
 * Markdown lays itself out to the width it is given, so its rows may not be
 * wrapped again here: a second pass would break a fence or a table the markdown
 * just drew. A block with a limit is a preview, and the rows it drops are
 * counted on the closing rule: a reader who cannot see the whole text still has
 * to see that it continues.
 */
export function frameLines(lines: readonly string[], width: number, faces: FrameFaces, limit = Number.POSITIVE_INFINITY): string[] {
  const inside = faces.drawn ? width - FRAME_COLUMNS : width
  const body = lines.slice(0, Math.max(0, limit))
  const rows = body.map(line => textRow(faces.text(line), inside))
  if (!faces.drawn) return rows
  const side = faces.border(FRAME_GLYPHS.side)
  return [
    faces.border(`${FRAME_GLYPHS.topLeft}${frameRule(inside, 0)}${FRAME_GLYPHS.topRight}`),
    ...rows.map(row => `${side}${row}${side}`),
    faces.border(`${FRAME_GLYPHS.bottomLeft}${frameRule(inside, lines.length - body.length)}${FRAME_GLYPHS.bottomRight}`),
  ]
}

/**
 * One block of already-rendered rows as a band draws it: a row of air, a marked
 * rule, the rows themselves, a marked rule, and the air that closes the block off
 * from the next one.
 *
 * The rows are placed, never padded and never cut: the block laid itself out to
 * the width it was given, and every column a band does not spend is one a reader
 * gets to select. The end marks are what a band says instead of sides — the block
 * is closed, and the rows between the rules are whole. A dropped tail is counted on the
 * closing rule exactly as a box counts one, so a fold reads the same in either
 * shape.
 */
export function bandLines(lines: readonly string[], width: number, faces: BandFaces, limit = Number.POSITIVE_INFINITY): string[] {
  const room = Math.max(0, width)
  const body = lines.slice(0, Math.max(0, limit))
  const rows = body.map(faces.text)
  if (!faces.drawn) return rows
  // Air only where there is a message to set apart from the next block: a block
  // with no rows at all would otherwise spend two rules and two rows of nothing.
  const air = rows.length === 0 ? [] : [BAND_AIR]
  return [
    ...air,
    bandRule(room, 0, BAND_MARKS.open, faces),
    ...rows,
    bandRule(room, lines.length - body.length, BAND_MARKS.close, faces),
    ...air,
  ]
}

/**
 * One block of plain text as a bar draws it.
 *
 * A block without a limit is the prompt itself, which is never cut; the text is
 * wrapped here because nothing upstream knows the frame's own width. The text is
 * drawn without colour: a frame holds the surface's own drafts, whose styling is
 * the frame's, and a sequence that reached one would fight the frame that owns it.
 */
export function frameText(text: string, width: number, faces: FrameFaces, limit = Number.POSITIVE_INFINITY): string[] {
  const inside = faces.drawn ? width - FRAME_COLUMNS : width
  const drawn = renderTerminalText(text, { color: 'none' })
  return frameLines(wrapTextWithAnsi(drawn, textWidth(inside)), width, faces, limit)
}
