import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import { renderTerminalText } from '../terminal-text.ts'

/**
 * The frame every prompt is closed into.
 *
 * The editor, the prompts queued above it, and the prompts already submitted
 * draw the same glyphs at the same width, so one prompt reads as the same object
 * through its whole life; keeping the shape here is what stops the three from
 * drifting.
 */
export const FRAME_GLYPHS = { topLeft: '╭', topRight: '╮', bottomLeft: '╰', bottomRight: '╯', side: '│' } as const

/** The frame costs one column each side, so the text wraps that much narrower. */
export const FRAME_COLUMNS = 2
/** One column of air inside the frame, so a full line never touches the border. */
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

/** How one block of text paints itself inside the bar that carries it. */
export interface FrameFaces {
  /** Paints one row of the block's own text. */
  readonly text: (line: string) => string
  /** Paints the frame's rules and its two sides. */
  readonly border: (rule: string) => string
  /** Whether the frame may be drawn at all. */
  readonly framed: boolean
}

/** Whether a bar has the width, and the visible border, to close a frame. */
export function canFrame(width: number, borderVisible: boolean): boolean {
  return borderVisible && width >= MIN_BOX_WIDTH
}

/**
 * One block of already-rendered rows as a bar draws it: padded to the frame's
 * own text width, and closed into it when the frame can be drawn.
 *
 * Markdown lays itself out to the width it is given, so its rows may not be
 * wrapped again here: a second pass would break a fence or a table the markdown
 * just drew. A block with a limit is a preview, and the rows it drops are
 * counted on the closing rule: a reader who cannot see the whole text still has
 * to see that it continues.
 */
export function frameLines(lines: readonly string[], width: number, faces: FrameFaces, limit = Number.POSITIVE_INFINITY): string[] {
  const inside = faces.framed ? width - FRAME_COLUMNS : width
  const body = lines.slice(0, Math.max(0, limit))
  const rows = body.map(line => textRow(faces.text(line), inside))
  if (!faces.framed) return rows
  const side = faces.border(FRAME_GLYPHS.side)
  return [
    faces.border(`${FRAME_GLYPHS.topLeft}${frameRule(inside, 0)}${FRAME_GLYPHS.topRight}`),
    ...rows.map(row => `${side}${row}${side}`),
    faces.border(`${FRAME_GLYPHS.bottomLeft}${frameRule(inside, lines.length - body.length)}${FRAME_GLYPHS.bottomRight}`),
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
  const inside = faces.framed ? width - FRAME_COLUMNS : width
  const drawn = renderTerminalText(text, { color: 'none' })
  return frameLines(wrapTextWithAnsi(drawn, textWidth(inside)), width, faces, limit)
}
