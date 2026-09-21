import {
  Editor,
  isKittyProtocolActive,
  matchesKey,
  stripTerminalSequences,
  type EditorTheme,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@earendil-works/pi-tui'
import { ENTER_KEY, defaultKeymap, type Keymap } from '../input/actions.ts'
import { promptKeys } from '../input/keymap.ts'
import { FRAME_COLUMNS, FRAME_GLYPHS, MIN_BOX_WIDTH, PADDING_X } from './frame.ts'

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
 * The line feed a plain Enter is handed to the base class as.
 *
 * The base owns what a newline does to paste markers, history, and undo, and it
 * reads this byte as one in every terminal mode, including the modes where it
 * no longer calls Enter itself a newline.
 */
const NEWLINE_BYTE = '\n'

/** The one sequence a terminal that reports no modifiers sends for alt+enter. */
const LEGACY_ALT_ENTER = '\u001b\r'

/**
 * The chords as the keyboard protocol spells them.
 *
 * The base class reads a legacy alt+enter and a bare line feed as line breaks
 * before it looks at any binding, so each press is handed over as the chord the
 * map actually holds for it. The submit path then runs whole, with the same
 * guards a real chord meets, instead of a second sender beside it.
 */
const KITTY_ALT_ENTER = '\u001b[13;3u'
const KITTY_CTRL_ENTER = '\u001b[13;5u'
const KITTY_CTRL_J = '\u001b[106;5u'

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

  constructor(tui: TUI, theme: EditorTheme, private readonly keymap: () => Keymap = defaultKeymap) {
    super(tui, theme, { paddingX: PADDING_X })
  }

  /**
   * Read the two presses the base class cannot place on its own.
   *
   * Enter breaks the line while the reader keeps that key for the line, so the
   * press the base would submit with becomes a newline — except while it is
   * picking a completion, the one press that chooses something instead of
   * sending it, and except on a bar a question or a picker has borrowed, whose
   * keys belong to whoever borrowed it.
   */
  override handleInput(data: string): void {
    if (this.disableSubmit) {
      super.handleInput(data)
      return
    }
    const keys = promptKeys(this.keymap())
    // A bare line feed is a line break in the base class whatever the map says,
    // so a reader who moved the line break off ctrl+j and sends with it would
    // keep getting lines. It is read before the Return guard because a terminal
    // without the protocol reports that byte as Return as well.
    if (data === NEWLINE_BYTE && keys.submit.includes('ctrl+j')) {
      super.handleInput(KITTY_CTRL_J)
      return
    }
    if (keys.enterBreaksLine && matchesKey(data, ENTER_KEY) && !this.isShowingAutocomplete()) {
      super.handleInput(NEWLINE_BYTE)
      return
    }
    // Only while the terminal cannot tell alt+enter apart from a mapping: with
    // the protocol active the same sequence is the reader's shift+enter, which
    // is a newline and has to stay one. The spelling follows the binding, so a
    // reader who sends with alt+enter alone is answered too.
    if (data === LEGACY_ALT_ENTER && !isKittyProtocolActive()) {
      if (keys.submit.includes('alt+enter')) {
        super.handleInput(KITTY_ALT_ENTER)
        return
      }
      if (keys.submit.includes('ctrl+enter')) {
        super.handleInput(KITTY_CTRL_ENTER)
        return
      }
    }
    super.handleInput(data)
  }

  /** Tag the closing rule so {@link render} can find where the box ends. */
  protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
    return `${super.renderBottomBorder(width, hiddenLineCount)}${CLOSING_TAG}`
  }

  /** A rule redrawn as a box edge, so the corners carry the border's own colour. */
  private edge(open: string, close: string, row: string): string {
    return this.borderColor(`${open}${stripTerminalSequences(row)}${close}`)
  }

  /**
   * Rewrite one row of the text before it is framed, so a subclass can hide
   * what it collects without hiding the box the reader types inside.
   */
  protected decorateText(row: string): string {
    return row
  }

  override render(width: number): string[] {
    const side = this.borderColor(FRAME_GLYPHS.side)
    // A frame narrower than its own furniture would eat the text it exists to
    // hold, and a hidden border token asks for no frame at all: both cases keep
    // the plain rules rather than reserve columns for what nobody can see.
    if (width < MIN_BOX_WIDTH || side === '') {
      this.boxed = false
      return super.render(width).map(row => this.decorateText(row))
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
    lines.push(this.edge(FRAME_GLYPHS.topLeft, FRAME_GLYPHS.topRight, rows[0] ?? ''))
    for (const row of text) lines.push(`${side}${this.decorateText(row)}${side}`)
    lines.push(this.edge(FRAME_GLYPHS.bottomLeft, FRAME_GLYPHS.bottomRight, rows[closing]!.replace(CLOSING_TAG, '')))
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
