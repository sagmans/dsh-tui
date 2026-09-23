import { type Component, type SizeValue, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import type { TuiToken } from '../theme-tokens.ts'
import type { TuiTheme } from '../theme.ts'
import { canFrame, frameLines, FRAME_COLUMNS } from './frame.ts'
import type { PickerCard } from './picker.ts'

/** The columns a list's rows are indented by, and the ones a wrapped line under them uses. */
const ROW_INDENT = '   '
const TEXT_INDENT = '    '
/** The mark a cursor falls back to when the reader has not set one, so no literal lives in a template. */
const CURSOR_MARK = '❯'
/** An unselected row has no cursor, and a blank column is not a value to configure. */
const NO_CURSOR = ' '

/** One wrapped block of plain text under a prefix, at the width the card has. */
function pushWrapped(lines: string[], text: string, width: number, prefix: string, token: TuiToken, theme: TuiTheme): void {
  const lead = visibleWidth(prefix)
  const indent = ' '.repeat(lead)
  const wrapped = wrapTextWithAnsi(theme.rich(text, { token, column: lead }), Math.max(1, width - lead))
  wrapped.forEach((line, index) => {
    lines.push(theme.cut(`${index === 0 ? prefix : indent}${line}`, width, ''))
  })
}

/**
 * The rows a list draws, wherever it is drawn.
 *
 * One renderer for the card, so the list at the end of the transcript and the
 * box over it cannot drift apart: a field added to a card reaches both at once.
 * The width is the room the rows themselves have, which is what a frame around
 * them narrows before it is asked for.
 */
export function pickerCardLines(picker: PickerCard, width: number, theme: TuiTheme): string[] {
  const lines: string[] = []
  if (theme.visible('picker.title')) {
    const glyph = theme.glyph('picker.glyph')
    const lead = glyph === '' ? '' : `${glyph} `
    lines.push(theme.cut(theme.rich(`${lead}${picker.title}`, { token: 'picker.title', column: visibleWidth(lead) }), width, ''))
  }
  if (picker.note !== undefined && theme.visible('picker.note')) {
    pushWrapped(lines, picker.note, width, TEXT_INDENT, 'picker.note', theme)
  }
  if (picker.filter !== '' && theme.visible('picker.filter')) {
    lines.push(theme.cut(theme.rich(`${TEXT_INDENT}filter: ${picker.filter}`, { token: 'picker.filter', column: visibleWidth(TEXT_INDENT) }), width, ''))
  }
  if (picker.above > 0 && theme.visible('picker.scrollNewer')) {
    lines.push(theme.style('picker.scrollNewer', theme.cut(`${ROW_INDENT}… ${picker.above} newer`, width, '')))
  }
  for (const row of picker.rows) {
    const token = row.current ? 'picker.rowCurrent' : 'picker.row'
    if (!theme.visible(token)) continue
    const cursor = row.current ? theme.glyph('picker.cursor') || CURSOR_MARK : NO_CURSOR
    const text = row.description === undefined
      ? `${cursor} ${row.label}`
      : `${cursor} ${row.label} — ${row.description}`
    lines.push(theme.cut(theme.rich(`${ROW_INDENT}${text}`, { token, column: visibleWidth(ROW_INDENT) }), width, ''))
  }
  if (picker.below > 0 && theme.visible('picker.scrollOlder')) {
    lines.push(theme.style('picker.scrollOlder', theme.cut(`${ROW_INDENT}… ${picker.below} older`, width, '')))
  }
  if (theme.visible('picker.hint')) {
    // The hint names the keys that leave the list, so it folds rather than
    // being cut: a narrow screen must still be told the way out.
    pushWrapped(lines, picker.hint, width, ROW_INDENT, 'picker.hint', theme)
  }
  return lines
}

/**
 * Share of the terminal a popup may take.
 *
 * The box is an overlay on work the reader is in the middle of, so it never
 * claims the screen: the rows behind it stay the context for what is being
 * chosen, and the editor stays where the reader left it.
 */
const HEIGHT_PERCENT = 80
/** Air between the box and the terminal's edge, so the frame never touches one. */
const MARGIN = 1
/** A box narrower than this cannot name an action and its keys on one row. */
const MIN_WIDTH = 40
/** Past this the rows are mostly empty, and a list reads better narrow than stretched. */
const MAX_WIDTH = 100
/** Rows the box spends before the list itself: two rules, the heading, the filter line, and the hint. */
const CHROME_ROWS = 5
/** Rows the two scroll counts may take when the list is longer than the window. */
const MARKER_ROWS = 2
/** A list that can show a row and still say the map continues. */
const MIN_ROWS = 3

/** The same share as the library resolves a percentage SizeValue, so the option and the row budget cannot disagree. */
export const POPUP_MAX_HEIGHT: SizeValue = `${HEIGHT_PERCENT}%`

/** The columns the box may take on a terminal this wide. */
export function popupWidth(columns: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, columns - MARGIN * 2))
}

/** The rows the box may occupy, resolved the way the library resolves a percentage. */
export function popupHeight(rows: number): number {
  return Math.floor((rows * HEIGHT_PERCENT) / 100)
}

/** How many list rows fit in that height, with the frame's own rows and the scroll counts reserved. */
export function popupRowBudget(rows: number): number {
  return Math.max(MIN_ROWS, popupHeight(rows) - CHROME_ROWS - MARKER_ROWS)
}

/**
 * A list drawn as a box over the surface rather than at the end of it.
 *
 * The box is only a frame: the rows, the filter, and the counts are the card's,
 * which the list builds to whatever budget this component can afford. A screen
 * too short for the whole card shrinks the window rather than the box, because
 * the hint naming the keys that close it is the last thing that may fall off.
 */
export class PickerPopup implements Component {
  constructor(
    private readonly card: (rows: number) => PickerCard | undefined,
    /** The terminal the box is drawn on, read per paint so a resize lands on the next frame. */
    private readonly rows: () => number,
    private readonly theme: TuiTheme,
  ) {}

  invalidate(): void {
    // Nothing is cached: the card is read fresh on every frame.
  }

  /** The card closed into a frame, or nothing when the list is already gone. */
  private box(picker: PickerCard | undefined, width: number): string[] {
    if (picker === undefined) return []
    const drawn = canFrame(width, this.theme.visible('picker.border'))
    const inside = drawn ? width - FRAME_COLUMNS : width
    return frameLines(pickerCardLines(picker, inside, this.theme), width, {
      text: line => line,
      border: rule => this.theme.style('picker.border', rule),
      drawn,
    })
  }

  render(width: number): string[] {
    if (width <= 0) return []
    const rows = this.rows()
    const room = popupHeight(rows)
    let budget = popupRowBudget(rows)
    for (;;) {
      const lines = this.box(this.card(budget), width)
      // A refusal note can spend rows the budget did not reserve, so a card that
      // still overflows asks for a shorter window rather than lose its closing
      // rule to the library's own clamp.
      if (lines.length <= room || budget <= MIN_ROWS) return lines
      budget = Math.max(MIN_ROWS, budget - (lines.length - room))
    }
  }
}
