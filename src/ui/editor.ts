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
import { FRAME_COLUMNS, RAIL_COLUMNS, FRAME_GLYPHS, MIN_BOX_WIDTH, MIN_RAIL_WIDTH, PADDING_X, textRow } from './frame.ts'

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
/** Typed text contains no escapes, so only the base editor's cursor cell can match. */
const SYNTHETIC_CURSOR = /\u001b\[7m([^\u001b]*)\u001b\[0m/gu
/** Only acceptance chords need a live consent projection before changing the draft. */
const GHOST_ACCEPT_ALL_KEY = 'ctrl+e'
const GHOST_WORD_RIGHT_ACTION = 'tui.editor.cursorWordRight'

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
  /** Probe already-loaded entries only: consent must gate exposure, not trigger storage access. */
  suggestion(input: GhostRequest): string | undefined
  /** Paint one run of the suffix; '' leaves the run undrawn. */
  paint(text: string, cell: GhostCell): string
}

/**
 * The input bar shares the messages' left rail without enclosing the draft.
 *
 * The base editor still owns wrapping and scrolling, so only its enclosing
 * rules are removed. Completion stays above the draft to avoid covering the
 * line being typed, and scroll counts keep clipped text discoverable.
 */
export class BoxedEditor extends Editor {
  /** Rows the menu took in the last render; a click there belongs to the list. */
  private menuRows = 0
  /** Rows between the rules in the last render; how the base editor counts its own. */
  private textRows = 0
  /** Pointer translation is safe only after recognizing the base layout. */
  private mapped = false
  /** Hidden rows stay discoverable after removing the enclosing rules. */
  private hiddenAbove = 0
  private hiddenBelow = 0
  /** Pointer offsets follow only the furniture actually drawn. */
  private railColumns = 0
  private topIndicatorRows = 0

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
    this.hiddenBelow = hiddenLineCount
    return `${super.renderBottomBorder(width, hiddenLineCount)}${CLOSING_TAG}`
  }

  /** The base owns scrolling; its count survives without its top rule. */
  protected override renderTopBorder(width: number, hiddenLineCount: number): string {
    this.hiddenAbove = hiddenLineCount
    return super.renderTopBorder(width, hiddenLineCount)
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
    if (brush === undefined) return undefined
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
    // An absent cached match cannot expose history; projecting every plugin's settings here would stall ordinary typing.
    return suffix === undefined || !brush.enabled() ? undefined : renderTerminalText(suffix, { color: 'none' })
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
    return before + brush.paint(first, 'rest') + brush.paint(rest.join(''), 'rest') + spaces
  }

  /**
   * Take a ghost-accepting key before the base sees it, so the key returns to
   * its own meaning the moment nothing is offered.
   */
  private acceptGhost(data: string): boolean {
    const wordRight = getKeybindings().matches(data, GHOST_WORD_RIGHT_ACTION)
    // Normal input cannot accept a ghost, so it must not pay for history consent or lookup.
    if (!wordRight && !matchesKey(data, GHOST_ACCEPT_ALL_KEY)) return false
    const suffix = this.currentGhostSuffix()
    if (suffix === undefined) return false
    if (wordRight) {
      const word = nextGhostWord(suffix)
      if (word === undefined) return false
      this.insertTextAtCursor(word)
      this.tui.requestRender()
      return true
    }
    this.insertTextAtCursor(suffix)
    this.tui.requestRender()
    return true
  }

  override render(width: number): string[] {
    // Borrowed question editors remain dialog furniture, not conversation messages.
    const enclosed = this.disableSubmit
    const minimum = enclosed ? MIN_BOX_WIDTH : MIN_RAIL_WIDTH
    const side = width >= minimum ? this.borderColor(FRAME_GLYPHS.side) : ''
    this.railColumns = side === '' ? 0 : enclosed ? FRAME_COLUMNS : RAIL_COLUMNS
    const boxed = enclosed && this.railColumns > 0
    const inside = width - this.railColumns
    const ghost = this.disableSubmit ? undefined : this.currentGhostSuffix()
    const rows = super.render(inside)
    const closing = rows.findIndex(row => row.includes(CLOSING_TAG))
    // An unfamiliar base layout must not receive guessed pointer offsets.
    if (closing < 0) {
      this.mapped = false
      return rows.map(row => row.replace(CLOSING_TAG, ''))
    }
    const menu = rows.slice(closing + 1)
    const text = rows.slice(1, closing)
    this.menuRows = menu.length
    this.textRows = text.length
    this.mapped = true
    this.topIndicatorRows = boxed || this.hiddenAbove > 0 ? 1 : 0
    const lines = menu.map(row => row + ' '.repeat(this.railColumns))
    const indicator = (direction: string, count: number): string =>
      side + textRow(this.borderColor(`${direction} ${count} more`), inside)
    const edge = (open: string, row: string, close: string): string =>
      this.borderColor(open + stripTerminalSequences(row) + close)
    if (boxed) lines.push(edge(FRAME_GLYPHS.topLeft, rows[0] ?? '', FRAME_GLYPHS.topRight))
    else if (this.hiddenAbove > 0) lines.push(indicator('↑', this.hiddenAbove))
    for (const row of text) lines.push(side + this.decorateText(this.ghostRow(row, ghost).replace(SYNTHETIC_CURSOR, '$1')) + (boxed ? side : ''))
    if (boxed) lines.push(edge(FRAME_GLYPHS.bottomLeft, rows[closing]!.replace(CLOSING_TAG, ''), FRAME_GLYPHS.bottomRight))
    else if (this.hiddenBelow > 0) lines.push(indicator('↓', this.hiddenBelow))
    return lines
  }

  /**
   * Map a click back through the frame and the lifted menu.
   *
   * The base editor hit-tests the rows it painted in its own order — the input
   * under the top rule, the menu after the bottom one — and measures columns
   * from the edge of the width it was asked for. This subclass draws the menu
   * first, removes the rules, and adds a rail, so clicks must be translated
   * back before that hit test can say what it hit.
   */
  override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (!this.mapped) return super.handleMouse(event)
    const width = event.width - this.railColumns
    if (event.y < this.menuRows) {
      return super.handleMouse({ ...event, width, y: event.y + this.textRows + 2 })
    }
    return super.handleMouse({ ...event, width, x: event.x - (this.railColumns > 0 ? RAIL_COLUMNS : 0), y: event.y - this.menuRows + 1 - this.topIndicatorRows })
  }
}
