import {
  type Component,
  type MarkdownTheme,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui'
import { cardDetailRows, clip, oneLine, shellFoldHint, shellRetentionHint, type CardPreview, type CardRow, type CardStat, type CardStatKind, type ToolCard, type ToolCardKind, type ToolSubCall } from '../cards.ts'
import { defaultKeymap, hintKeys, type Keymap } from '../input/actions.ts'
import { CUSTOM_ROW_NUMBER, type GateCard } from '../gates.ts'
import { displayText } from '../text.ts'
import type { TranscriptEntry, TranscriptModel } from '../transcript.ts'
import { DEFAULT_TOOL_DISPLAY, type ToolDisplaySpec } from '../tool-display.ts'
import { CARD_ROW_TOKEN, type TuiToken } from '../theme-tokens.ts'
import type { TuiTheme } from '../theme.ts'
import { canFrame, frameLines, FRAME_COLUMNS, textWidth } from './frame.ts'
import { ANSWER_FACE, type MarkdownFace, type MarkdownRenderer } from './markdown.ts'
import type { PickerCard } from './picker.ts'
import { RowCache } from './rows.ts'

const DETAIL_INDENT = '    '
const OPTION_INDENT = '   '
/** A nested call is a signpost under its card, so it sits one step shallower than that card's detail. */
const SUBCALL_INDENT = '  '
/**
 * Blank columns a one-line tool row keeps at the right edge.
 *
 * The cut mark would otherwise sit under the terminal's own last column, where
 * a border or the cursor lives; the padding is part of the look, not a
 * preference, so it is not a settings key.
 */
const COLLAPSED_EDGE_PADDING = 5

/** The mark a cursor falls back to when the reader has not set one, so no literal lives in a template. */
const CURSOR_MARK = '❯'
const APPROVAL_MARK = '⚠'
const QUESTION_MARK = '?'
const CHECKBOX_ON = '[x]'
const CHECKBOX_OFF = '[ ]'
/** A row that a card's kind does not map draws as generic detail. */
const FALLBACK_ROW_TOKEN: TuiToken = 'tool.detail'
/** An unselected row has no cursor, and a blank column is not a value to configure. */
const NO_CURSOR = ' '
/** The words an opened card uses when retention, not the fold, dropped rows. */
const CARD_HINT_RETAINED = 'more lines not shown'
/** What a hint names when the reader has unbound the key it would advertise. */
const REASONING_FOLD_FALLBACK = 'shift+tab'
const CARD_OPEN_FALLBACK = 'ctrl+o'
/** What separates a card's header from its measured facts, and the facts from each other. */
const STAT_LEAD = '  '
const STAT_SEPARATOR = ' · '
/** The symbol that says what a fact counts; a size needs none. */
const STAT_SYMBOL: Readonly<Record<CardStatKind, string>> = {
  added: '+',
  changed: '~',
  removed: '-',
  size: '',
}
/** Which colour draws each fact, so added, changed, and removed never share one. */
const STAT_TOKEN: Readonly<Record<CardStatKind, TuiToken>> = {
  added: 'tool.stat.added',
  changed: 'tool.stat.changed',
  removed: 'tool.stat.removed',
  size: 'tool.stat.size',
}

/**
 * A markdown theme that keeps every element in one token.
 *
 * A thought is deliberately recessive, and the answer's theme would let a
 * heading or a link inside it outshine the answer it produced. The structure
 * still shows because markdown draws it around the text — bullets, fences,
 * indents, table rules — rather than in the text's own colour.
 */
function recessiveMarkdownTheme(style: (text: string) => string): MarkdownTheme {
  return {
    heading: style,
    link: style,
    linkUrl: style,
    code: style,
    codeBlock: style,
    codeBlockBorder: style,
    quote: style,
    quoteBorder: style,
    hr: style,
    listBullet: style,
    bold: style,
    italic: style,
    strikethrough: style,
    underline: style,
  }
}

/** One row a gate draws: a numbered option, or the free-text row below them. */
interface GateRow {
  readonly number: number
  readonly label: string
  readonly description: string | undefined
  readonly current: boolean
  readonly selected: boolean
}

/** Which rows the reader has opened by key; a click decides for one message instead. */
export interface ViewState {
  readonly expandCards: boolean
  readonly expandReasoning: boolean
  /** Whether the calls a PTC program dispatched draw under the card that made them. */
  readonly expandSubCalls: boolean
}

/**
 * The state a reader gets before opening anything, and the view's own fallback.
 *
 * Thoughts start folded because they can be long enough to push the answer off
 * the screen. Cards and a program's calls start from the reader's own `tools:`
 * settings, which ship folded for cards — one clipped line each — and inline for
 * a program's calls, whose one line per dispatch is what the card stands for.
 */
export const DEFAULT_VIEW_STATE: ViewState = { expandCards: false, expandReasoning: false, expandSubCalls: true }

/**
 * Where one clickable message drew, so a click can find what it landed on.
 *
 * A card's rows cover the calls it dispatched, so the card and each of those
 * calls have a span; the click takes the tightest one it falls in.
 */
interface ClickSpan {
  /** Stable across redraws, so a click outlives the entry it was made on. */
  readonly key: string
  readonly start: number
  /** Exclusive: the row after the message's last. */
  readonly end: number
  /** Whether the message was open when those rows were drawn. */
  readonly expanded: boolean
}

/** Keys are prefixed because cards, thoughts, and dispatches all share one map. */
const toolClickKey = (id: string): string | undefined => (id === '' ? undefined : `tool:${id}`)
const reasoningClickKey = (id: string): string | undefined => (id === '' ? undefined : `reason:${id}`)
const subCallClickKey = (parentId: string, id: string): string => `sub:${parentId}/${id}`

/** The column a one-line tool row must not pass, so a cut never reaches the edge. */
const collapsedEdge = (width: number): number => Math.max(1, width - COLLAPSED_EDGE_PADDING)

/**
 * Renders the transcript rows and any pending gate as terminal lines.
 *
 * The component stays a pure projection: it holds no cache of its own, so a
 * resize, a resume, or an open gate redraws the same rows without replaying
 * anything. Everything it draws came from a model, a tool, or a file, so the
 * text passes through the display escaping before it is styled.
 */
/** What sits below the transcript while the reader is being asked something. */
export interface TranscriptViewOptions {
  readonly state?: () => ViewState
  readonly gate?: () => GateCard | undefined
  readonly picker?: () => PickerCard | undefined
  /** Injectable so a test can see that a repaint reused the rows it had. */
  readonly rows?: RowCache<TranscriptEntry>
  /**
   * The keys in force, read live.
   *
   * A hint that names a key is a promise about what a press does, so it has to
   * be drawn from the same table the press is matched against — including after
   * a settings edit moved the key.
   */
  readonly keys?: () => Keymap
  /**
   * How one tool's cards draw, read per render.
   *
   * The settings document is hot-reloaded, so a captured table would keep
   * folding a session under the policy it happened to start with.
   */
  readonly toolDisplay?: (tool: string) => ToolDisplaySpec
}

export class TranscriptView implements Component {
  private readonly rows: RowCache<TranscriptEntry>
  /**
   * Fold choices the reader made by clicking, per message.
   *
   * Absent means the key or the tool's own policy decides, so a settings edit
   * stays in charge of messages nobody clicked. Keyed by the call or thought id
   * rather than by the entry, because a result replaces the entry a click was
   * made on and a thought outlives the live row that streamed it.
   */
  private readonly clicked = new Map<string, boolean>()
  /** The rows each clickable message drew last render, for mapping a click back to it. */
  private spans: readonly ClickSpan[] = []
  /** The same spans relative to their entry, so a cached entry still answers clicks. */
  private readonly entrySpans = new WeakMap<TranscriptEntry, readonly ClickSpan[]>()

  constructor(
    private readonly model: TranscriptModel,
    private readonly theme: TuiTheme,
    private readonly markdown: MarkdownRenderer,
    private readonly options: TranscriptViewOptions = {},
  ) {
    this.rows = options.rows ?? new RowCache<TranscriptEntry>()
  }

  private get viewState(): ViewState {
    return this.options.state?.() ?? DEFAULT_VIEW_STATE
  }

  /** The display the reader configured for a tool, or the shipped one. */
  private toolDisplay(tool: string): ToolDisplaySpec {
    return this.options.toolDisplay?.(tool) ?? DEFAULT_TOOL_DISPLAY
  }

  /**
   * Whether one tool message draws open.
   *
   * A click outranks the key, which outranks the tool's start state: Ctrl+O
   * stays "show me everything", while one clicked message keeps the state the
   * reader gave it.
   */
  private expansionOf(entry: Extract<TranscriptEntry, { kind: 'tool' }>): boolean {
    const key = toolClickKey(entry.id)
    const clicked = key === undefined ? undefined : this.clicked.get(key)
    return clicked ?? (this.viewState.expandCards || !this.toolDisplay(entry.card.tool).collapsed)
  }

  /** Whether one thought draws its body; a click decides for that thought alone. */
  private reasoningOpen(entry: Extract<TranscriptEntry, { kind: 'reasoning' }>): boolean {
    const key = reasoningClickKey(entry.id)
    const clicked = key === undefined ? undefined : this.clicked.get(key)
    return clicked ?? this.viewState.expandReasoning
  }

  /** Whether one dispatched call draws its argument in full; a click decides for that call. */
  private subCallOpen(parentId: string, id: string): boolean {
    return this.clicked.get(subCallClickKey(parentId, id)) ?? false
  }

  /**
   * Answer a click on a message by folding or unfolding that one row.
   *
   * The tightest span under the point wins, so a click on a dispatched call
   * opens that call rather than the card around it. Only a left click is
   * consumed: a press, a drag, and a wheel belong to the surface's own
   * selection and scrolling, and a row that swallowed them would cost the
   * reader the ability to copy the command it just drew.
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== 'click' || event.button !== 'left') return undefined
    let span: ClickSpan | undefined
    for (const candidate of this.spans) {
      if (event.y < candidate.start || event.y >= candidate.end) continue
      if (span === undefined || candidate.end - candidate.start < span.end - span.start) span = candidate
    }
    if (span === undefined) return undefined
    this.clicked.set(span.key, !span.expanded)
    return { handled: true, render: true }
  }

  /** The cache's own account of the work it avoided; a test reads this. */
  rowStats(): { readonly hits: number; readonly misses: number; readonly size: number } {
    return this.rows.stats()
  }

  invalidate(): void {
    // The rows are keyed by width and expansion state, so a real change misses
    // anyway; an explicit invalidate means the caller wants them rebuilt.
    this.rows.clear()
  }

  /** Wrap one text block under a prefix, keeping the prefix's column budget. */
  private pushWrapped(
    lines: string[],
    text: string,
    width: number,
    prefix: string,
    style: (text: string) => string,
  ): void {
    const lead = visibleWidth(prefix)
    const indent = ' '.repeat(lead)
    const wrapped = wrapTextWithAnsi(displayText(text), Math.max(1, width - lead))
    wrapped.forEach((line, index) => {
      lines.push(style(this.theme.cut(`${index === 0 ? prefix : indent}${line}`, width, '')))
    })
  }

  /**
   * Wrap one already-styled block under a prefix.
   *
   * A card header mixes tokens — title, argument, stats — in a single string, so
   * it cannot go through {@link pushWrapped}, which escapes and restyles plain
   * text. Its width still has to fold at the screen edge rather than be cut,
   * because the argument is the part a reader scans for and a silently dropped
   * command is worse than a taller card.
   */
  private pushStyledWrapped(lines: string[], content: string, width: number, prefix: string): void {
    const lead = visibleWidth(prefix)
    const indent = ' '.repeat(lead)
    const wrapped = wrapTextWithAnsi(content, Math.max(1, width - lead))
    wrapped.forEach((line, index) => {
      lines.push(this.theme.cut(`${index === 0 ? prefix : indent}${line}`, width, ''))
    })
  }

  /** The rows one markdown message draws, with the padding pi-tui adds for background styling removed. */
  private markdownLines(text: string, width: number, live: boolean, face: MarkdownFace): string[] {
    return this.markdown
      .render(displayText(text), Math.max(1, width), live, face)
      .map(line => line.replace(/[ \t]+$/u, ''))
  }

  /**
   * Render one message's text as markdown.
   *
   * A thought passes its own face and an indent, so the row stays visibly a
   * detail of the step that produced it rather than a second answer.
   */
  private pushMarkdown(
    lines: string[],
    text: string,
    width: number,
    live: boolean,
    face: MarkdownFace = ANSWER_FACE,
    indent = '',
  ): void {
    const lead = visibleWidth(indent)
    for (const line of this.markdownLines(text, Math.max(1, width - lead), live, face)) {
      // A blank markdown line stays blank: it shows nothing, so it holds nothing.
      if (line === '') {
        lines.push('')
        continue
      }
      lines.push(this.theme.cut(`${indent}${line}`, width, '…'))
    }
  }

  /**
   * The face a thought is drawn in.
   *
   * Its shade stays the thought body's and it asks for no drawing: a diagram in
   * the middle of a thought would carry the answer's weight, and the answer's
   * colours would make the thinking compete with it.
   */
  private reasoningFace(): MarkdownFace {
    const body = (text: string): string => this.theme.style('transcript.reasoning.body', text)
    return { name: 'reasoning', base: { color: body }, theme: recessiveMarkdownTheme(body), transform: false }
  }

  /** The face a submitted prompt is drawn in: its structure is markdown's, its shade stays the prompt's. */
  private userFace(): MarkdownFace {
    return { name: 'user', base: { color: text => this.theme.style('transcript.user', text) } }
  }

  /** The live map, or the shipped one for a caller that did not lend one. */
  private keymap(): Keymap {
    return this.options.keys?.() ?? defaultKeymap()
  }

  private reasoningFoldHint(): string {
    return hintKeys(this.keymap(), 'surface.reasoning') || REASONING_FOLD_FALLBACK
  }

  private pushReasoning(lines: string[], entry: Extract<TranscriptEntry, { kind: 'reasoning' }>, width: number, spans: ClickSpan[]): void {
    if (!this.theme.visible('transcript.reasoning.summary')) return
    const start = lines.length
    const open = this.reasoningOpen(entry)
    const glyph = this.theme.glyph('transcript.reasoning.summary')
    const lead = glyph === '' ? '' : `${glyph} `
    // A folded row carries the key that opens it, because a count with no way to
    // reach the text reads the same as the text never having arrived. The key
    // rides the row rather than a line of its own, so naming the hidden body
    // costs no vertical space.
    const suffix = !open && entry.body !== '' && this.theme.visible('transcript.reasoning.hint')
      ? ` (${this.reasoningFoldHint()})`
      : ''
    // The key is kept whole: the summary is the part that gives up room.
    const room = Math.max(1, width - visibleWidth(suffix))
    const summary = this.theme.style('transcript.reasoning.summary', this.theme.cut(`${lead}${displayText(entry.summary)}`, room, ''))
    const lined = suffix === '' ? summary : `${summary}${this.theme.style('transcript.reasoning.hint', suffix)}`
    // The key is kept whole only while the row has room for it: a row wider than
    // the surface loses its tail to the terminal, and the terminal's clamp is not
    // one this component can count on.
    lines.push(this.theme.cut(lined, width, '…'))
    if (open && this.theme.visible('transcript.reasoning.body')) {
      this.pushMarkdown(lines, entry.body, width, entry.live, this.reasoningFace(), DETAIL_INDENT)
    }
    const key = reasoningClickKey(entry.id)
    if (key !== undefined) spans.push({ key, start, end: lines.length, expanded: open })
  }

  private pushCard(lines: string[], entry: Extract<TranscriptEntry, { kind: 'tool' }>, width: number, spans: ClickSpan[]): void {
    const card = entry.card
    const spec = this.toolDisplay(card.tool)
    const expanded = this.expansionOf(entry)
    const start = lines.length
    // What a folded card shows of its rows is the reader's choice, so a shell
    // run no longer spends twenty rows on screen just because its output is the
    // answer: the answer is one click away, and the row it costs is one.
    const preview: CardPreview = expanded
      ? { expanded: true }
      : spec.output === 'tail'
        ? { expanded: false, preview: 'tail', rows: spec.tail }
        : { expanded: false, preview: 'title' }
    const { lines: detail, hidden } = cardDetailRows(card, preview)
    const titleToken = card.failed ? 'tool.failed.title' : 'tool.title'
    const glyphToken = card.failed ? 'tool.failed.glyph' : 'tool.glyph'
    if (expanded) {
      const { lead, body } = this.renderHead(card, titleToken, glyphToken)
      // A header that folds keeps the argument and its stats; a terminal command
      // can be longer than the screen, so it wraps under its own indent.
      if (body !== '') this.pushStyledWrapped(lines, body, width, lead)
    } else {
      const head = this.renderCollapsedHead(card, hidden, titleToken, glyphToken, width)
      if (head !== '') lines.push(this.theme.cut(head, collapsedEdge(width), '…'))
    }
    // The calls a program dispatched sit under the header whether the card is
    // open or folded: one line per call is what the card stands for, and hiding
    // them behind the card's own fold made a program's work invisible.
    if (this.viewState.expandSubCalls) this.pushSubCalls(lines, entry, width, spans)
    if (expanded && card.kind === 'terminal' && card.argument !== undefined && card.argument !== '' && this.theme.visible('tool.args')) {
      this.pushStyledWrapped(lines, this.theme.style('tool.args', displayText(card.argument)), width, DETAIL_INDENT)
    }
    for (const row of detail) {
      const drawn = this.detailRow(row, card.kind)
      // A row whose every part is hidden draws nothing, and nothing must not
      // cost a line: the indent would read as an empty row the card does not have.
      if (drawn === '') continue
      lines.push(this.theme.cut(`${DETAIL_INDENT}${drawn}`, width, ''))
    }
    // The pill is not output, so it draws after the preview window rather than
    // inside it: a run bounded to its tail still reports how it ended. Folded,
    // it rides the header instead, where it costs no row of its own.
    if (expanded && card.kind === 'terminal' && card.status !== undefined && this.theme.visible('tool.terminal.status')) {
      lines.push(this.theme.cut(`${DETAIL_INDENT}${this.theme.style('tool.terminal.status', displayText(card.status))}`, width, ''))
    }
    // A shell card's rows are kept from the end, so a hidden count always names
    // the rows *before* what is on screen and the hint has to say so; every
    // other card keeps its head, where a neutral count is enough. A folded card
    // that shows a tail is bounded by that window, an opened one by retention,
    // so the opened hint promises no more than memory kept.
    if (hidden > 0 && this.theme.visible('tool.hint')) {
      const hint = preview.expanded
        ? card.kind === 'terminal' ? shellRetentionHint(hidden) : `${hidden} ${CARD_HINT_RETAINED}`
        : preview.preview === 'tail'
          ? shellFoldHint(hidden, hintKeys(this.keymap(), 'surface.toolDetail') || CARD_OPEN_FALLBACK)
          : undefined
      if (hint !== undefined) {
        lines.push(this.theme.style('tool.hint', this.theme.cut(`${DETAIL_INDENT}${hint}`, width, '')))
      }
    }
    const key = toolClickKey(entry.id)
    if (key !== undefined) spans.push({ key, start, end: lines.length, expanded })
  }

  /**
   * The calls one card dispatched, one entry each.
   *
   * A nested call is a signpost rather than a card of its own, so it keeps one
   * entry per call, clipped to that entry until the reader clicks it: the
   * argument is the part a reader scans for, and one that always wrapped pushed
   * the rest of the program off the screen.
   */
  private pushSubCalls(lines: string[], entry: Extract<TranscriptEntry, { kind: 'tool' }>, width: number, spans: ClickSpan[]): void {
    const card = entry.card
    const subCalls = card.subCalls ?? []
    for (const call of subCalls) {
      const start = lines.length
      const open = this.subCallOpen(entry.id, call.id)
      const titleToken = call.failed ? 'tool.failed.title' : 'tool.subcall.title'
      const title = this.theme.visible(titleToken) ? this.theme.style(titleToken, displayText(call.title)) : ''
      const argument = call.argument === undefined || !this.theme.visible('tool.subcall.args')
        ? ''
        : ` ${this.theme.style('tool.subcall.args', displayText(call.argument))}`
      const drawn = `${title}${argument}`
      // A row whose every part is hidden draws nothing, and nothing must not
      // cost a line the card does not have.
      if (drawn === '') continue
      if (open) {
        this.pushStyledWrapped(lines, drawn, width, SUBCALL_INDENT)
        this.pushSubCallOutput(lines, call, width)
      } else {
        lines.push(this.theme.cut(`${SUBCALL_INDENT}${drawn}`, collapsedEdge(width), '…'))
      }
      spans.push({ key: subCallClickKey(entry.id, call.id), start, end: lines.length, expanded: open })
    }
    const hidden = (card.subCallsTotal ?? subCalls.length) - subCalls.length
    if (hidden > 0 && this.theme.visible('tool.hint')) {
      lines.push(this.theme.style('tool.hint', this.theme.cut(`${SUBCALL_INDENT}… ${hidden} more calls`, width, '')))
    }
  }

  /**
   * The rows a dispatched shell call printed, under the argument a click opened.
   *
   * The parent card keeps only the program's return value, so a call's own
   * output is otherwise gone; a reader who opens the row is asking for it. The
   * retention is the card's, so a long run still says what it dropped.
   */
  private pushSubCallOutput(lines: string[], call: ToolSubCall, width: number): void {
    const output = call.output
    if (output === undefined) return
    for (const row of output.rows) {
      const drawn = this.detailRow(row, output.kind)
      if (drawn === '') continue
      lines.push(this.theme.cut(`${DETAIL_INDENT}${drawn}`, width, ''))
    }
    const hidden = output.totalLines - output.rows.length
    if (hidden > 0 && this.theme.visible('tool.hint')) {
      lines.push(this.theme.style('tool.hint', this.theme.cut(`${DETAIL_INDENT}${shellRetentionHint(hidden)}`, width, '')))
    }
  }

  /**
   * A folded card's one row: label, clipped argument, measured facts, outcome.
   *
   * The outcome rides this row rather than a row of its own, because one line
   * per call is what folding promises. A shell card's hidden rows are counted
   * here too: its output is the answer the reader asked for, and a fold that
   * left no trace of it would read as a call that produced nothing.
   *
   * The argument is the part that gives up room: it is clipped to whatever the
   * label, the facts, and the outcome leave before the edge, so a wide terminal
   * shows more of the call while a narrow one still shows how it ended.
   */
  private renderCollapsedHead(card: ToolCard, hidden: number, titleToken: TuiToken, glyphToken: TuiToken, width: number): string {
    const edge = collapsedEdge(width)
    const lead = this.cardLead(titleToken, glyphToken)
    const title = this.cardTitle(card, titleToken)
    const separator = this.statSeparator()
    // The facts carry their own lead; the outcome and the count join whatever
    // precedes them, so the folded line reads as one sentence about the run.
    let tail = this.renderStats(card.stats)
    const status = card.kind === 'terminal' && card.status !== undefined && this.theme.visible('tool.terminal.status')
      ? this.theme.style('tool.terminal.status', displayText(card.status))
      : ''
    if (status !== '') tail += `${separator}${status}`
    if (card.kind === 'terminal' && hidden > 0) {
      const count = this.renderStats([{ kind: 'size', text: `${hidden} line${hidden === 1 ? '' : 's'}` }], '')
      if (count !== '') tail += `${separator}${count}`
    }
    const fixed = visibleWidth(lead) + visibleWidth(title) + visibleWidth(tail)
    const room = Math.max(0, edge - fixed - (title === '' ? 0 : 1))
    const argument = room > 0 ? this.cardArgument(card, room) : ''
    const head = [title, argument].filter(part => part !== '').join(' ')
    // A row with no visible label or argument opens with the tail, and a line
    // that begins with a separator reads as a row that lost its first word.
    if (head === '' && tail.startsWith(separator)) tail = tail.slice(separator.length)
    return `${lead}${head}${tail}`
  }

  /**
   * One detail row, drawn with its own kind's colours or nothing at all.
   *
   * The row says what it is, so the renderer never guesses from the text: a diff
   * line beginning with "+" is an addition because the presenter said so, not
   * because of its first character.
   */
  private detailRow(row: CardRow, kind: ToolCardKind): string {
    return row.parts
      .map(part => {
        const token = CARD_ROW_TOKEN[kind]?.[part.class] ?? FALLBACK_ROW_TOKEN
        return this.theme.visible(token) ? this.theme.style(token, displayText(part.text)) : ''
      })
      .join('')
  }

  /** The mark that introduces a card, empty when the theme hides its label. */
  private cardLead(titleToken: TuiToken, glyphToken: TuiToken): string {
    const glyph = this.theme.visible(titleToken) ? this.theme.glyph(glyphToken) : ''
    return glyph === '' ? '' : `${glyph} `
  }

  /** A card's label, styled, or nothing when the theme hides it. */
  private cardTitle(card: ToolCard, titleToken: TuiToken): string {
    return this.theme.visible(titleToken) ? this.theme.style(titleToken, displayText(card.title)) : ''
  }

  /** A card's argument, styled and flattened, clipped to `limit` when one is given. */
  private cardArgument(card: ToolCard, limit?: number): string {
    if (card.argument === undefined || card.argument === '' || !this.theme.visible('tool.args')) return ''
    const shown = limit === undefined ? card.argument : clip(oneLine(card.argument), limit)
    return this.theme.style('tool.args', displayText(shown))
  }

  /**
   * A card's header: its label, its argument, and its measured facts.
   *
   * The glyph is returned apart from the body so a wrapped continuation can
   * align under the label rather than under the mark. An opened terminal's
   * argument is left out because it needs a row of its own — it is the one
   * argument that can be a whole command rather than a word.
   */
  private renderHead(card: ToolCard, titleToken: TuiToken, glyphToken: TuiToken): { lead: string; body: string } {
    const lead = this.cardLead(titleToken, glyphToken)
    const title = this.cardTitle(card, titleToken)
    const argument = card.kind === 'terminal' ? '' : this.cardArgument(card)
    const head = [title, argument].filter(part => part !== '').join(' ')
    return { lead, body: head + this.renderStats(card.stats) }
  }

  /** The separator a header uses between its label, its facts, and its outcome. */
  private statSeparator(): string {
    return this.theme.style('tool.stat.separator', STAT_SEPARATOR)
  }

  /**
   * The measured facts, each in its own colour, or nothing when none is visible.
   *
   * The lead is a parameter because a header that already carries a title and an
   * argument separates its facts with the same mark as its outcome, while facts
   * on a row of their own stand apart with blank columns.
   */
  private renderStats(stats: readonly CardStat[] | undefined, lead = STAT_LEAD): string {
    if (stats === undefined || stats.length === 0) return ''
    const drawn = stats
      .filter(stat => this.theme.visible(STAT_TOKEN[stat.kind]))
      .map(stat => this.theme.style(STAT_TOKEN[stat.kind], `${STAT_SYMBOL[stat.kind]}${displayText(stat.text)}`))
    if (drawn.length === 0) return ''
    return `${lead}${drawn.join(this.statSeparator())}`
  }

  private pushPicker(lines: string[], picker: PickerCard, width: number): void {
    lines.push('')
    if (this.theme.visible('picker.title')) {
      const glyph = this.theme.glyph('picker.glyph')
      const lead = glyph === '' ? '' : `${glyph} `
      lines.push(this.theme.style('picker.title', this.theme.cut(`${lead}${displayText(picker.title)}`, width, '')))
    }
    if (picker.note !== undefined && this.theme.visible('picker.note')) {
      this.pushWrapped(lines, picker.note, width, DETAIL_INDENT, text => this.theme.style('picker.note', text))
    }
    if (picker.filter !== '' && this.theme.visible('picker.filter')) {
      lines.push(this.theme.style('picker.filter', this.theme.cut(`${DETAIL_INDENT}filter: ${displayText(picker.filter)}`, width, '')))
    }
    if (picker.above > 0 && this.theme.visible('picker.scrollNewer')) {
      lines.push(this.theme.style('picker.scrollNewer', this.theme.cut(`${OPTION_INDENT}… ${picker.above} newer`, width, '')))
    }
    for (const row of picker.rows) {
      const token = row.current ? 'picker.rowCurrent' : 'picker.row'
      if (!this.theme.visible(token)) continue
      const cursor = row.current ? this.theme.glyph('picker.cursor') || CURSOR_MARK : NO_CURSOR
      const text = row.description === undefined
        ? `${cursor} ${row.label}`
        : `${cursor} ${row.label} — ${row.description}`
      lines.push(this.theme.style(token, this.theme.cut(`${OPTION_INDENT}${displayText(text)}`, width, '')))
    }
    if (picker.below > 0 && this.theme.visible('picker.scrollOlder')) {
      lines.push(this.theme.style('picker.scrollOlder', this.theme.cut(`${OPTION_INDENT}… ${picker.below} older`, width, '')))
    }
    if (this.theme.visible('picker.hint')) {
      lines.push(this.theme.style('picker.hint', this.theme.cut(`${OPTION_INDENT}${displayText(picker.hint)}`, width, '')))
    }
  }

  private pushGate(lines: string[], gate: GateCard, width: number): void {
    lines.push('')
    if (this.theme.visible('gate.title')) {
      const glyphToken = gate.kind === 'approval' ? 'gate.glyphApproval' : 'gate.glyphQuestion'
      const glyph = this.theme.glyph(glyphToken) || (gate.kind === 'approval' ? APPROVAL_MARK : QUESTION_MARK)
      // The question is the thing being decided, so it wraps rather than being
      // cut: a reader cannot answer a sentence they were not shown.
      this.pushWrapped(lines, gate.title, width, `${glyph} `, text => this.theme.style('gate.title', text))
    }
    if (this.theme.visible('gate.detail')) {
      for (const detail of gate.detail) {
        this.pushWrapped(lines, detail, width, DETAIL_INDENT, text => this.theme.style('gate.detail', text))
      }
    }
    gate.options.forEach((option, position) => {
      this.pushGateRow(lines, width, {
        number: gate.optionOffset + position + 1,
        label: option.label,
        description: option.description,
        current: option.current,
        selected: option.selected,
      })
    })
    // The free-text row is drawn under the window rather than inside it: it is
    // the one row that must never scroll out of reach, and the window's own
    // numbering is left running 1..n above it.
    if (gate.custom !== undefined) {
      this.pushGateRow(lines, width, {
        number: CUSTOM_ROW_NUMBER,
        label: gate.custom.label,
        description: gate.custom.description,
        current: gate.custom.current,
        selected: gate.custom.selected,
      })
    }
    // The answer belongs to the row it fills: the free-text row, or the question
    // itself when typing is the only way to answer it. The rows come from the
    // surface's own editor, so they are placed rather than restyled — it draws
    // its frame, its padding, and its cursor for the width it is given.
    if (gate.answerInput !== undefined) {
      const room = Math.max(1, width - visibleWidth(OPTION_INDENT))
      for (const row of gate.answerInput.render(room)) lines.push(`${OPTION_INDENT}${row}`)
    }
    // The keys are how the gate is answered at all, so they wrap rather than
    // lose their tail at a narrow edge.
    if (this.theme.visible('gate.hint')) {
      this.pushWrapped(lines, gate.hint, width, OPTION_INDENT, text => this.theme.style('gate.hint', text))
    }
  }

  /**
   * One row a reader can choose: the cursor, the box, the number, the label.
   *
   * The row wraps under the label it belongs to rather than at the screen edge,
   * because the label and its description together are what tells two rows
   * apart, and a mark on a continuation line reads as another row.
   */
  private pushGateRow(lines: string[], width: number, row: GateRow): void {
    const token = row.current ? 'gate.optionCurrent' : 'gate.option'
    if (!this.theme.visible(token)) return
    const cursor = row.current ? this.theme.glyph('gate.cursor') || CURSOR_MARK : NO_CURSOR
    const box = row.selected ? CHECKBOX_ON : CHECKBOX_OFF
    const lead = `${OPTION_INDENT}${cursor} ${box} ${row.number}. `
    const text = row.description === undefined ? row.label : `${row.label} — ${row.description}`
    // The text reaches pushWrapped unescaped: it escapes once, and escaping a
    // second time would show the reader the escape instead of the character.
    this.pushWrapped(lines, text, width, lead, body => this.theme.style(token, body))
  }

  /** The rows one transcript entry becomes; `live` marks the entry the turn is still writing. */
  private renderEntry(entry: TranscriptEntry, lines: string[], width: number, live: boolean, spans: ClickSpan[]): void {
    switch (entry.kind) {
      case 'tool':
        this.pushCard(lines, entry, width, spans)
        return
      case 'reasoning':
        this.pushReasoning(lines, entry, width, spans)
        return
      case 'assistant':
        this.pushMarkdown(lines, entry.text, width, live)
        return
      case 'user': {
        if (!this.theme.visible('transcript.user')) return
        // A prompt is boxed wherever it is read, so the row it left in the queue
        // and the row it becomes here are recognisably the same object.
        const framed = canFrame(width, this.theme.visible('editor.border'))
        const inside = framed ? width - FRAME_COLUMNS : width
        // Markdown lays itself out to the frame's text width, so the frame may
        // only place the rows: wrapping them again would break what it drew.
        const body = this.markdownLines(entry.text, textWidth(inside), false, this.userFace())
        lines.push(...frameLines(body, width, {
          text: line => line,
          border: rule => this.theme.editor.borderColor(rule),
          framed,
        }))
        return
      }
      case 'notice':
        if (!this.theme.visible('transcript.notice')) return
        this.pushWrapped(lines, entry.text, width, this.elementLead('transcript.notice'), text => this.theme.style('transcript.notice', text))
        return
      case 'marker':
        if (!this.theme.visible('transcript.marker')) return
        this.pushWrapped(lines, entry.text, width, this.elementLead('transcript.marker'), text => this.theme.style('transcript.marker', text))
        return
    }
  }

  /** The mark and the space that introduce an element, empty when it has none. */
  private elementLead(token: TuiToken): string {
    const glyph = this.theme.visible(token) ? this.theme.glyph(token) : ''
    return glyph === '' ? '' : `${glyph} `
  }

  render(width: number): string[] {
    if (width <= 0) return []
    const state = this.viewState
    // The revision is part of the key: rows drawn under an older theme table
    // must miss, or a settings change would restyle only the rows that happened
    // to be redrawn for another reason.
    const baseTag = `${width}|${state.expandCards ? 'c' : '-'}${state.expandReasoning ? 'r' : '-'}${state.expandSubCalls ? 'p' : '-'}|${this.theme.revision}`
    const lines: string[] = []
    const spans: ClickSpan[] = []
    const settled = this.model.settledCount()
    const entries = this.model.entries()
    for (const [index, entry] of entries.entries()) {
      const start = lines.length
      // Every fold this entry can answer to is part of the tag, so clicking one
      // message — or one call inside it — rebuilds that message alone while the
      // rows around it stay cached.
      const open = entry.kind === 'tool' ? this.expansionOf(entry) : entry.kind === 'reasoning' ? this.reasoningOpen(entry) : undefined
      const marks = entry.kind === 'tool'
        ? `${open === true ? '+' : '-'}${(entry.card.subCalls ?? []).map(call => (this.subCallOpen(entry.id, call.id) ? '1' : '0')).join('')}`
        : open === true ? '+' : '-'
      const tag = `${baseTag}|${marks}`
      const local: ClickSpan[] = []
      // The in-flight rows change on every frame, so caching them would only
      // fill the cache with objects nobody will ask for again.
      if (index >= settled) {
        this.renderEntry(entry, lines, width, true, local)
        // An in-flight entry draws straight into the transcript, so the spans it
        // recorded already name transcript rows; offsetting them again would move
        // every hit target as many rows down as the entry's own start.
        spans.push(...local)
      } else {
        const cached = this.rows.lookup(entry, tag)
        const saved = this.entrySpans.get(entry)
        if (cached !== undefined && saved !== undefined) {
          lines.push(...cached)
          local.push(...saved)
        } else {
          const rendered: string[] = []
          this.renderEntry(entry, rendered, width, false, local)
          this.rows.store(entry, tag, rendered)
          this.entrySpans.set(entry, local)
          lines.push(...rendered)
        }
        // A cached span is kept relative to its entry so the entry can hand it
        // back; a click needs it in transcript rows.
        for (const span of local) {
          spans.push({ key: span.key, start: span.start + start, end: span.end + start, expanded: span.expanded })
        }
      }
    }
    this.spans = spans
    const picker = this.options.picker?.()
    if (picker !== undefined) this.pushPicker(lines, picker, width)
    const gate = this.options.gate?.()
    if (gate !== undefined) this.pushGate(lines, gate, width)
    return lines
  }
}
