/**
 * Terminal text, read the way a terminal would read it.
 *
 * Tool output, file content, and model text all reach the screen, and this
 * module is the only place that decides what a control byte means. It offers
 * two policies over one token stream, so they can never disagree about where a
 * sequence ends:
 *
 * - {@link renderTerminalText} draws what the terminal would have drawn: a
 *   whitelisted SGR subset becomes real colour at the session's colour budget,
 *   a tab lands on its stop, a carriage return repaints the row it sits on, and
 *   every sequence a terminal would *act* on is consumed, so it acts on
 *   nothing. Bytes that are not a sequence are still spelled out rather than
 *   dropped, because silently swallowing text would hide what a tool said.
 * - {@link escapeTerminalText} is for text a buffer or a file will hold: every
 *   control character is spelled out, because an editor cannot draw an escape
 *   and must not execute one.
 *
 * Sharing one scanner matters for more than agreement: pi-tui's own escape
 * scanner recognises less than a terminal does (a `\x1b[?25l` left in a drawn
 * string would make its width arithmetic swallow the text after it), so a
 * sequence that is not SGR must be gone before any width is measured.
 */

import { visibleWidth } from '@earendil-works/pi-tui'
import type { ColourMode } from './theme-capability.ts'
import { NEEDS_READING, scan, spellControls, type Piece } from './terminal-text/scan.ts'
import { GROUND, applySgr, encoder, type Encoder, type TextStyle } from './terminal-text/sgr.ts'

/** Columns between tab stops: the POSIX default, and what every terminal still uses. */
export const TAB_STOP = 8

/** Whether a tab is drawn on its stop, or kept for a buffer that will hold it. */
export type TabPolicy = 'expand' | 'keep'

export interface EscapeTextOptions {
  /** The column the text starts at, so its first tab lands on the terminal's next stop. */
  readonly column?: number | undefined
  readonly tab?: TabPolicy | undefined
}

export interface RenderTextOptions {
  /** The colour budget the session has; `none` drops tool styling entirely. */
  readonly color: ColourMode
  /** SGR already in effect — an element's own colour, which a foreign reset returns to. */
  readonly base?: string | undefined
  readonly column?: number | undefined
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** How many characters a reader sees in this piece, which is what a row budget pays for. */
function visibleLength(piece: Piece): number {
  switch (piece.token.kind) {
    case 'text': {
      let count = 0
      for (const _ of GRAPHEMES.segment(piece.raw)) count += 1
      return count
    }
    case 'sgr':
    case 'consumed':
    case 'incomplete': return 0
    default: return 1
  }
}

/**
 * The tab stop a tab at `column` reaches.
 *
 * Strictly after the cursor, the way a terminal steps: a tab that is already on
 * a stop still advances a full stop rather than standing still, which is what
 * makes a column of tabs line up.
 */
function nextStop(column: number): number {
  return (Math.floor(column / TAB_STOP) + 1) * TAB_STOP
}

/**
 * Spell every control character, expanding a tab to the stop the terminal would
 * have used.
 *
 * The column is what makes a tab land where it landed for the tool that wrote
 * it: a row indented by four columns reaches its stop four columns later than
 * the same row at the left edge.
 */
export function escapeTerminalText(raw: string, options: EscapeTextOptions = {}): string {
  const tab = options.tab ?? 'expand'
  const expandTabs = tab === 'expand'
  let column = options.column ?? 0
  let out = ''
  for (const piece of scan(raw)) {
    switch (piece.token.kind) {
      case 'text':
        out += piece.raw
        if (expandTabs) column += visibleWidth(piece.raw)
        break
      case 'lineFeed':
        out += '\n'
        column = 0
        break
      case 'tab': {
        if (!expandTabs) {
          out += '\t'
          break
        }
        const stop = nextStop(column)
        out += ' '.repeat(stop - column)
        column = stop
        break
      }
      default: {
        const spelledText = spellControls(piece.raw)
        out += spelledText
        column += spelledText.length
        break
      }
    }
  }
  return out
}

interface Cell {
  col: number
  width: number
  text: string
  style: TextStyle
}

/**
 * Draw text as the terminal that produced it would have drawn it.
 *
 * A carriage return repaints the row from the column the fragment starts at
 * and a backspace moves one column left, so a progress bar collapses to the
 * state it settled on instead of showing every repaint in a row. That starting
 * column is also a left margin: a row indented by the layout cannot be repainted
 * by the text it holds, which is the one thing a carriage return could
 * otherwise do to the frame. Styling is kept per cell, so what survives a
 * repaint keeps the colour it was written with.
 */
export function renderTerminalText(raw: string, options: RenderTextOptions): string {
  if (!NEEDS_READING.test(raw)) return raw
  const { color, base = '', column = 0 } = options
  const codes = encoder(color, base)
  let style: TextStyle = GROUND
  let previous: TextStyle = GROUND
  let cells: Cell[] = []
  let cursor = column
  let out = ''

  const write = (text: string, width: number): void => {
    if (width === 0) {
      const last = cells[cells.length - 1]
      if (last !== undefined && last.col + last.width === cursor) last.text += text
      return
    }
    cells = cells.filter(cell => cell.col >= cursor + width || cell.col + cell.width <= cursor)
    let at = cells.findIndex(cell => cell.col >= cursor + width)
    if (at < 0) at = cells.length
    cells.splice(at, 0, { col: cursor, width, text, style })
    cursor += width
  }

  const flush = (): void => {
    if (cells.length > 0) {
      let drawn = column
      for (const cell of cells) {
        if (cell.col > drawn) {
          out += codes.between(previous, GROUND)
          previous = GROUND
          out += ' '.repeat(cell.col - drawn)
        }
        out += codes.between(previous, cell.style)
        previous = cell.style
        out += cell.text
        drawn = cell.col + cell.width
      }
    }
    cells = []
    cursor = column
  }

  for (const piece of scan(raw)) {
    switch (piece.token.kind) {
      case 'text':
        for (const { segment } of GRAPHEMES.segment(piece.raw)) write(segment, visibleWidth(segment))
        break
      case 'lineFeed':
        flush()
        out += '\n'
        break
      case 'tab':
        cursor = nextStop(cursor)
        break
      case 'carriageReturn':
        cursor = column
        break
      case 'backspace':
        cursor = Math.max(column, cursor - 1)
        break
      case 'sgr':
        style = applySgr(style, piece.token.params, color)
        break
      case 'control': {
        const mark = spellControls(piece.raw)
        write(mark, mark.length)
        break
      }
      case 'consumed':
      case 'incomplete':
        break
    }
  }
  flush()
  return out
}

/**
 * Cut text to a budget of the characters a reader sees.
 *
 * Sequences are not content: counting them would let a coloured row lose its
 * words sooner than a plain one, and cutting through one would leave a half
 * sequence for a renderer to guess at. The cut falls between grapheme clusters
 * for the same reason every other cut in the surface does — half a joined emoji
 * is the same glitch as half a colour code.
 */
export function clipVisibleGraphemes(raw: string, limit: number): string {
  const pieces = scan(raw)
  let total = 0
  for (const piece of pieces) total += visibleLength(piece)
  if (total <= limit) return raw
  const budget = Math.max(0, limit - 1)
  let kept = 0
  let out = ''
  for (const piece of pieces) {
    if (kept >= budget) break
    if (piece.token.kind === 'text') {
      for (const { segment } of GRAPHEMES.segment(piece.raw)) {
        if (kept >= budget) break
        out += segment
        kept += 1
      }
      continue
    }
    const length = visibleLength(piece)
    if (kept + length > budget) break
    out += piece.raw
    kept += length
  }
  return `${out}…`
}
