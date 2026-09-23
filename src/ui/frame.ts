import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import { renderTerminalText } from '../terminal-text.ts'

/**
 * The two shapes the surface closes a block into, and the glyphs a box needs.
 *
 * A bar the reader types in is a box: its sides and its padding are what say
 * "type here", and nothing is ever read back out of it. A block already written
 * is a band, which draws the rules above and below it and nothing else, so a
 * copy of one row is the row itself rather than the frame that held it and a
 * diagram keeps every column the terminal gave it. Both shapes take the same
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
 * One block of already-rendered rows as a band draws it: a rule above, the rows
 * themselves between them, and a rule below.
 *
 * The rows are placed, never padded and never cut: the block laid itself out to
 * the width it was given, and every column a band does not spend is one a reader
 * gets to select. A dropped tail is counted on the closing rule exactly as a box
 * counts one, so a fold reads the same in either shape.
 */
export function bandLines(lines: readonly string[], width: number, faces: FrameFaces, limit = Number.POSITIVE_INFINITY): string[] {
  const room = Math.max(0, width)
  const body = lines.slice(0, Math.max(0, limit))
  const rows = body.map(faces.text)
  if (!faces.drawn) return rows
  return [
    faces.border(frameRule(room, 0)),
    ...rows,
    faces.border(frameRule(room, lines.length - body.length)),
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
