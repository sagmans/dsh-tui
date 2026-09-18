import { visibleWidth } from '@earendil-works/pi-tui'

/**
 * The frame both input bars are closed into.
 *
 * The editor and the queued prompts waiting above it draw the same glyphs at
 * the same width, so a queued prompt reads as the same object as the line it
 * will become; keeping the shape here is what stops the two from drifting.
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
  const room = Math.max(0, textWidth(innerWidth) - visibleWidth(text))
  return `${' '.repeat(PADDING_X)}${text}${' '.repeat(room)}${' '.repeat(PADDING_X)}`
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
