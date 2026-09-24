import {
  Editor,
  getKeybindings,
  isKittyProtocolActive,
  matchesKey,
  stripTerminalSequences,
  visibleWidth,
  type EditorTheme,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@earendil-works/pi-tui'
import { defaultKeymap, type Keymap } from '../input/actions.ts'
import { ENTER_KEY } from '../input/key-press.ts'
import { ghostDisplayLine, ghostGraphemes, isCursorAtTextEnd, nextGhostWord, type EditorCursor } from '../input/ghost.ts'
import { promptKeys } from '../input/keymap.ts'
import { renderTerminalText } from '../terminal-text.ts'
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
const KITTY_CTRL_J = '\u001b[106;5u'

/**
 * The cell the base editor draws for a cursor parked past the last character.
 *
 * Ghost text takes that cell over: the base offers no seam for "style the text
 * after the cursor", so one paint pass finds the cell it drew and replaces the
 * padding after it. The cell looks the same when the cursor sits over a typed
 * space, which is why a caller also confirms the cursor is past the last
 * character before treating the sequence as padding.
 */
const CURSOR_AT_END = '\u001b[7m \u001b[0m'

/** Which run of a ghost is being drawn: the cursor cell, or the text after it. */
export type GhostCell = 'cursor' | 'rest'

/** What the bar knows when it asks for a suggestion. */
export interface GhostRequest {
  readonly text: string
  readonly lines: readonly string[]
  readonly cursor: EditorCursor
}

/**
 * The recorded-prompt suggestion the bar offers, and how to draw it.
 *
 * Kept as a collaborator rather than built in: the editor owns where the text
 * goes, while the surface owns where the entries come from and which shade they
 * are drawn in, so neither has to know the other's world.
 */
export interface GhostBrush {
  /** Whether the affordance may draw at all; colour and settings decide this. */
  enabled(): boolean
  /** The suffix to offer after the typed text, or undefined for none. */
  suggestion(input: GhostRequest): string | undefined
  /** Paint one run of the suffix; '' leaves the run undrawn. */
  paint(text: string, cell: GhostCell): string
}

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

  constructor(
    tui: TUI,
    theme: EditorTheme,
    private readonly keymap: () => Keymap = defaultKeymap,
    private readonly ghost?: GhostBrush,
  ) {
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
    if (this.acceptGhost(data)) return
    const keys = promptKeys(this.keymap())
    // A bare line feed is a line break in the base class whatever the map says,
    // so a reader who moved the line break off ctrl+j and sends with it would
    // keep getting lines. It is read before the Return guard because a terminal
    // without the protocol reports that byte as Return as well — and only
    // without it, because a terminal that speaks the protocol sends the chord
    // itself and reports a line feed for a key the reader meant as a line.
    if (data === NEWLINE_BYTE && !isKittyProtocolActive() && keys.submit.includes('ctrl+j')) {
      super.handleInput(KITTY_CTRL_J)
      return
    }
    if (keys.enterBreaksLine && matchesKey(data, ENTER_KEY) && !this.isShowingAutocomplete()) {
      super.handleInput(NEWLINE_BYTE)
      return
    }
    // Only while the terminal cannot tell alt+enter apart from a mapping, and
    // only for the reader who bound that key: with the protocol active the same
    // sequence is the reader's shift+enter, and a bar that answered it as a send
    // because some other chord contains the same bytes would be submitting a key
    // the reader never bound. A reader who keeps the sequence for a line is
    // answered by the library's own rule.
    if (data === LEGACY_ALT_ENTER && !isKittyProtocolActive() && keys.submit.includes('alt+enter')) {
      super.handleInput(KITTY_ALT_ENTER)
      return
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

  /** The suggestion to draw this paint, or undefined when the brush offers none. */
  private currentGhostSuffix(): string | undefined {
    const brush = this.ghost
    if (brush === undefined || !brush.enabled()) return undefined
    const lines = this.getLines()
    const cursor = this.getCursor()
    // A cursor parked over a typed space draws the same cell as one at the very
    // end, so the position has to be confirmed before a brush is asked at all.
    if (!isCursorAtTextEnd({ lines, cursor })) return undefined
    // The brush is a collaborator this class does not own, and its answer is
    // both drawn and inserted: a control sequence would reach the terminal or
    // the bar itself. The store refuses them too, so this only has to hold for
    // any other brush. The expanded text is what was actually written; a large
    // paste is stored as a marker and would otherwise match nothing.
    const suffix = brush.suggestion({ text: this.getExpandedText(), lines, cursor })
    // The bar paints this text itself, so it is drawn without colour: a sequence
    // the brush offered must not escape the face the bar is drawing it in.
    return suffix === undefined ? undefined : renderTerminalText(suffix, { color: 'none' })
  }

  /**
   * Replace the end-of-text cursor cell with the offered suffix.
   *
   * The base draws the cursor as one reverse-video cell and pads the rest of the
   * row; the suffix takes that cell plus the padding after it, so the row keeps
   * exactly its width and the cursor stays where the reader is typing.
   */
  private ghostRow(row: string, suffix: string | undefined): string {
    const brush = this.ghost
    if (brush === undefined || suffix === undefined) return row
    const cursorAt = row.indexOf(CURSOR_AT_END)
    if (cursorAt < 0) return row
    const before = row.slice(0, cursorAt)
    const pad = visibleWidth(row.slice(cursorAt + CURSOR_AT_END.length))
    // The freed cursor cell is one more column the suffix may fill.
    const room = pad + 1
    // A width-aware cut can split a wide grapheme or return the escape that
    // closed a style, so the fit is measured one grapheme at a time; when even
    // the first one is too wide, the row keeps the cursor the base drew.
    let drawn = ''
    let used = 0
    for (const grapheme of ghostGraphemes(ghostDisplayLine(suffix))) {
      const width = visibleWidth(grapheme)
      if (used + width > room) break
      drawn += grapheme
      used += width
    }
    if (drawn === '') return row
    const [first = '', ...rest] = ghostGraphemes(drawn)
    const spaces = ' '.repeat(Math.max(0, room - used))
    return before + brush.paint(first, 'cursor') + brush.paint(rest.join(''), 'rest') + spaces
  }

  /**
   * Take a ghost-accepting key before the base sees it, so the key returns to
   * its own meaning the moment nothing is offered.
   */
  private acceptGhost(data: string): boolean {
    const suffix = this.currentGhostSuffix()
    if (suffix === undefined) return false
    if (getKeybindings().matches(data, 'tui.editor.cursorWordRight')) {
      const word = nextGhostWord(suffix)
      if (word === undefined) return false
      this.insertTextAtCursor(word)
      this.tui.requestRender()
      return true
    }
    if (!matchesKey(data, 'ctrl+e')) return false
    this.insertTextAtCursor(suffix)
    this.tui.requestRender()
    return true
  }

  override render(width: number): string[] {
    const side = this.borderColor(FRAME_GLYPHS.side)
    // A frame narrower than its own furniture would eat the text it exists to
    // hold, and a hidden border token asks for no frame at all: both cases keep
    // the plain rules rather than reserve columns for what nobody can see.
    const ghost = this.disableSubmit ? undefined : this.currentGhostSuffix()
    if (width < MIN_BOX_WIDTH || side === '') {
      this.boxed = false
      return super.render(width).map(row => this.decorateText(this.ghostRow(row, ghost)))
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
    for (const row of text) lines.push(`${side}${this.decorateText(this.ghostRow(row, ghost))}${side}`)
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
