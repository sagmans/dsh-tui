import {
  Editor,
  stripTerminalSequences,
  type EditorTheme,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@earendil-works/pi-tui'

/** The frame the input bar is closed into: two corners per edge, one glyph per side. */
const TOP_LEFT = '╭'
const TOP_RIGHT = '╮'
const BOTTOM_LEFT = '╰'
const BOTTOM_RIGHT = '╯'
const SIDE = '│'

/** The frame costs one column each side, so the text wraps that much narrower. */
const FRAME_COLUMNS = 2
/** One column of air inside the frame, so a full line never touches the border. */
const PADDING_X = 1
/** A box needs both edges, both paddings, and one column left to type in. */
const MIN_BOX_WIDTH = FRAME_COLUMNS + PADDING_X * 2 + 1

/**
 * Marks the rule that closes the input while one render is in flight.
 *
 * The base editor paints its completion menu after that rule, and this subclass
 * has to know which rows those are to lift the menu above the box. The base
 * offers no seam for that boundary, so one render pass tags its own closing rule
 * and finds it again. The tag cannot collide with typed text, which the editor
 * strips of control characters, and it never reaches the screen because the same
 * pass removes it.
 */
const CLOSING_TAG = '\u0000'

/**
 * The input bar drawn as a box, with its completion menu above it.
 *
 * The editor already draws the two rules and pads every row to the width it is
 * given, so the frame comes from rendering two columns narrower and wrapping
 * what comes back. The menu is lifted above the box because the reader scans it
 * while writing: a list that grows upward never covers the line being typed.
 */
export class BoxedEditor extends Editor {
  /** Rows the menu took in the last render; a click there belongs to the list. */
  private menuRows = 0
  /** Rows between the rules in the last render; how the base editor counts its own. */
  private textRows = 0
  /** Whether the last render drew a frame, which is what a click is mapped through. */
  private boxed = false

  constructor(tui: TUI, theme: EditorTheme) {
    super(tui, theme, { paddingX: PADDING_X })
  }

  /** Tag the closing rule so {@link render} can find where the box ends. */
  protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
    return `${super.renderBottomBorder(width, hiddenLineCount)}${CLOSING_TAG}`
  }

  /** A rule redrawn as a box edge, so the corners carry the border's own colour. */
  private edge(open: string, close: string, row: string): string {
    return this.borderColor(`${open}${stripTerminalSequences(row)}${close}`)
  }

  override render(width: number): string[] {
    const side = this.borderColor(SIDE)
    // A frame narrower than its own furniture would eat the text it exists to
    // hold, and a hidden border token asks for no frame at all: both cases keep
    // the plain rules rather than reserve columns for what nobody can see.
    if (width < MIN_BOX_WIDTH || side === '') {
      this.boxed = false
      return super.render(width)
    }
    const rows = super.render(width - FRAME_COLUMNS)
    const closing = rows.findIndex(row => row.includes(CLOSING_TAG))
    // No tagged rule means the base did not paint the shape this class knows;
    // an unframed render reports that better than a frame drawn on a guess.
    if (closing < 0) return rows.map(row => row.replace(CLOSING_TAG, ''))
    const menu = rows.slice(closing + 1)
    const text = rows.slice(1, closing)
    this.menuRows = menu.length
    this.textRows = text.length
    this.boxed = true
    // The menu keeps the page's own width; only its rows moved above the box.
    const lines = menu.map(row => row + ' '.repeat(FRAME_COLUMNS))
    lines.push(this.edge(TOP_LEFT, TOP_RIGHT, rows[0] ?? ''))
    for (const row of text) lines.push(`${side}${row}${side}`)
    lines.push(this.edge(BOTTOM_LEFT, BOTTOM_RIGHT, rows[closing]!.replace(CLOSING_TAG, '')))
    return lines
  }

  /**
   * Map a click back through the frame and the lifted menu.
   *
   * The base editor hit-tests the rows it painted in its own order — the input
   * under the top rule, the menu after the bottom one — and measures columns
   * from the edge of the width it was asked for. This subclass draws the menu
   * first and indents every line by the frame, so a click has to be translated
   * back before that hit test can say what it hit.
   */
  override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (!this.boxed) return super.handleMouse(event)
    const width = event.width - FRAME_COLUMNS
    if (event.y < this.menuRows) {
      return super.handleMouse({ ...event, width, y: event.y + this.textRows + 2 })
    }
    return super.handleMouse({ ...event, width, x: event.x - 1, y: event.y - this.menuRows })
  }
}
