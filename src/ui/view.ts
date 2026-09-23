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
import { SECOND_MS, type LiveCallState, type TranscriptEntry, type TranscriptModel } from '../transcript.ts'
import { DEFAULT_TOOL_DISPLAY, type ToolDisplaySpec } from '../tool-display.ts'
import { CARD_ROW_TOKEN, type TuiToken } from '../theme-tokens.ts'
import type { TuiTheme } from '../theme.ts'
import { codeBlockLines } from './diff.ts'
import { canFrame, frameBlock, FRAME_COLUMNS, textWidth, type FrameRow } from './frame.ts'
import { ANSWER_FACE, type MarkdownFace, type MarkdownRenderer } from './markdown.ts'
import { pickerCardLines } from './picker-card.ts'
import type { PickerCard } from './picker.ts'
import { RowCache, type RowCacheStats } from './rows.ts'

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
/**
 * The mark that says a call is in flight.
 *
 * The same arrow the dock uses for what is still to do, because it answers the
 * same question — is this work still moving — and a second symbol for it would
 * read as a second state.
 */
/** A duration below a whole second is not a measurement, so it is not drawn. */
const MIN_ELAPSED_SECONDS = 1
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
 * indents, table rules — rather than in the text's own colour. A fenced diff is
 * the one block that does not recede: red and green are what the fence means
 * rather than how loudly it is drawn, and a thought showing a change is the
 * place the reader most needs to see which side of it moved.
 */
function recessiveMarkdownTheme(style: (text: string) => string, theme: TuiTheme): MarkdownTheme {
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
    highlightCode: (code, lang) => codeBlockLines(code, lang, {
      style: (token, text) => theme.style(token, text),
      visible: token => theme.visible(token),
      plain: style,
    }),
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
  /**
   * The framed rows each entry drew last render, for reading a copy back out.
   *
   * Relative to the entry for the same reason the spans are: a cached entry draws
   * no rows this frame and still has to answer for what it drew before.
   */
  private readonly entryCopy = new WeakMap<TranscriptEntry, readonly FrameRow[]>()
  /**
   * The framed rows the in-flight entries drew this frame.
   *
   * They cannot be kept by entry the way the settled ones are: every frame builds
   * a live entry as a fresh object, so a map keyed by it would never answer. A copy
   * is read against the last frame, so it is the render that keeps them.
   */
  private liveCopy: readonly FrameRow[] = []

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
  rowStats(): RowCacheStats {
    return this.rows.stats()
  }

  invalidate(): void {
    // The rows are keyed by width and expansion state, so a real change misses
    // anyway; an explicit invalidate means the caller wants them rebuilt.
    this.rows.clear()
  }

  /**
   * Wrap one text block under a prefix, keeping the prefix's column budget.
   *
   * The block is drawn before it is wrapped: a sequence a terminal would have
   * acted on has to be gone before pi-tui measures the row, and a tab has to
   * land on the stop the writer saw rather than one a wrapper would guess at.
   * The prefix seeds that stop, because it is already on the row.
   */
  private pushWrapped(
    lines: string[],
    text: string,
    width: number,
    prefix: string,
    token: TuiToken,
  ): void {
    const lead = visibleWidth(prefix)
    const indent = ' '.repeat(lead)
    const wrapped = wrapTextWithAnsi(this.theme.rich(text, { token, column: lead }), Math.max(1, width - lead))
    wrapped.forEach((line, index) => {
      lines.push(this.theme.cut(`${index === 0 ? prefix : indent}${line}`, width, ''))
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

  /**
   * The rows one markdown message draws, with the padding pi-tui adds for background styling removed.
   *
   * The source is drawn first so the markdown renderer never measures a sequence
   * it cannot see; its own spans are applied around the result afterwards.
   */
  private markdownLines(text: string, width: number, live: boolean, face: MarkdownFace, column = 0): string[] {
    return this.markdown
      .render(this.theme.rich(text, { column }), Math.max(1, width), live, face)
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
    for (const line of this.markdownLines(text, Math.max(1, width - lead), live, face, lead)) {
      // A blank markdown line stays blank: it shows nothing, so it holds nothing.
      if (line === '') {
        lines.push('')
        continue
      }
      lines.push(this.theme.cut(`${indent}${line}`, width, '…'))
    }
  }

  /**
   * One message closed into a frame, with its markdown laid out to what is left inside.
   *
   * A prompt and a reply are the two objects of an exchange, so both are drawn as
   * bars rather than as one more stretch of rows; the face, the border's element,
   * and whether the text is still arriving are the only differences. Markdown lays
   * itself out to the frame's text width, so the frame may only place the rows:
   * wrapping them again would break what it drew. The rows are recorded as they
   * are drawn, because a copy of this message will carry the frame with it and
   * only the drawing knows which columns of a row are the frame's.
   */
  private pushFramed(lines: string[], copy: FrameRow[], text: string, width: number, live: boolean, face: MarkdownFace, borderToken: TuiToken): void {
    const framed = canFrame(width, this.theme.visible(borderToken))
    const inside = framed ? width - FRAME_COLUMNS : width
    const body = this.markdownLines(text, textWidth(inside), live, face)
    const block = frameBlock(body, width, {
      text: line => line,
      border: rule => this.theme.style(borderToken, rule),
      framed,
    })
    lines.push(...block.drawn)
    copy.push(...block.copy)
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
    return { name: 'reasoning', base: { color: body }, theme: recessiveMarkdownTheme(body, this.theme), transform: false }
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
    const summary = this.theme.cut(this.theme.rich(`${lead}${entry.summary}`, { token: 'transcript.reasoning.summary', column: visibleWidth(lead) }), room, '')
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
    const live = this.model.liveCall(entry.id)
    // The card was drawn when the call was requested, so a duration measured at
    // render time is the only clock it can be shown with: the fold holds the one
    // timestamp this window has.
    const card = this.cardOf(entry.card, live)
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
    const titleToken = this.titleToken(card, { running: 'tool.running.title', failed: 'tool.failed.title' })
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
      this.pushStyledWrapped(lines, this.theme.rich(card.argument, { token: 'tool.args', column: visibleWidth(DETAIL_INDENT) }), width, DETAIL_INDENT)
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
      lines.push(this.theme.cut(`${DETAIL_INDENT}${this.theme.rich(card.status, { token: 'tool.terminal.status', column: visibleWidth(DETAIL_INDENT) })}`, width, ''))
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
      // A program's calls are the work between its start and its return value, so
      // each row's own name says what became of it — the call still in flight in
      // the running colour, one that failed in the failed colour, and one that is
      // back in the colour every settled name is read in.
      const titleToken = this.titleToken(call, { running: 'tool.subcall.running', failed: 'tool.failed.title' })
      const column = visibleWidth(SUBCALL_INDENT)
      const title = this.theme.visible(titleToken) ? this.theme.rich(call.title, { token: titleToken, column }) : ''
      const argument = call.argument === undefined || !this.theme.visible('tool.subcall.args')
        ? ''
        : this.theme.rich(call.argument, { token: 'tool.subcall.args', column })
      // How the call ended is the tool's own line about its outcome — a shell's
      // exit status — and it is the only part of a dispatch's result that fits on
      // the one row a reader scans.
      const status = call.status === undefined || !this.theme.visible('tool.terminal.status')
        ? ''
        : this.theme.rich(call.status, { token: 'tool.terminal.status', column })
      // Joined rather than concatenated: the name and the argument are one space
      // apart whether or not either of them is drawn at all, and the outcome joins
      // the row the way it joins every other one.
      const label = [title, argument.trim()].filter(part => part !== '').join(' ')
      const drawn = [label, status].filter(part => part !== '').join(this.statSeparator())
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
   * What a dispatched call declared and what it produced, under its argument.
   *
   * The parent card keeps only the program's return value, so both are otherwise
   * gone; a reader who opens the row is asking for them, which is why the call's
   * own rows come first and its outcome under them. Each section keeps the
   * retention its card used, so a long run still says what it dropped.
   */
  private pushSubCallOutput(lines: string[], call: ToolSubCall, width: number): void {
    for (const section of [call.presented, call.output]) {
      if (section === undefined) continue
      for (const row of section.rows) {
        const drawn = this.detailRow(row, section.kind)
        if (drawn === '') continue
        lines.push(this.theme.cut(`${DETAIL_INDENT}${drawn}`, width, ''))
      }
      const hidden = section.totalLines - section.rows.length
      if (hidden > 0 && this.theme.visible('tool.hint')) {
        // A shell's rows are kept from the end, so its hidden count names the
        // earlier lines; every other kind keeps its head, where the count is of
        // what follows and a neutral wording is what the card uses too.
        const hint = section.kind === 'terminal' ? shellRetentionHint(hidden) : `${hidden} ${CARD_HINT_RETAINED}`
        lines.push(this.theme.style('tool.hint', this.theme.cut(`${DETAIL_INDENT}${hint}`, width, '')))
      }
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
    // One row is what folding promises, so a running call reports its duration
    // on the same line rather than costing a row of its own.
    const elapsed = this.elapsedStat(card)
    // The facts carry their own lead; the outcome and the count join whatever
    // precedes them, so the folded line reads as one sentence about the run.
    let tail = this.renderStats(card.stats)
    const status = card.kind === 'terminal' && card.status !== undefined && this.theme.visible('tool.terminal.status')
      ? this.theme.rich(card.status, { token: 'tool.terminal.status' })
      : ''
    if (status !== '') tail += `${separator}${status}`
    if (card.kind === 'terminal' && hidden > 0) {
      const count = this.renderStats([{ kind: 'size', text: `${hidden} line${hidden === 1 ? '' : 's'}` }], '')
      if (count !== '') tail += `${separator}${count}`
    }
    if (elapsed !== '') tail += `${separator}${elapsed}`
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
        return this.theme.visible(token) ? this.theme.rich(part.text, { token, column: visibleWidth(DETAIL_INDENT) }) : ''
      })
      .join('')
  }

  /** The mark that introduces a card, empty when the theme hides its label. */
  private cardLead(titleToken: TuiToken, glyphToken: TuiToken): string {
    return this.theme.visible(titleToken) ? this.theme.glyph(glyphToken) : ''
  }

  /** A card's label, styled, or nothing when the theme hides it. */
  private cardTitle(card: ToolCard, titleToken: TuiToken): string {
    return this.theme.visible(titleToken) ? this.theme.rich(card.title, { token: titleToken }) : ''
  }

  /** A card's argument, styled and flattened, clipped to `limit` when one is given. */
  private cardArgument(card: ToolCard, limit?: number): string {
    if (card.argument === undefined || card.argument === '' || !this.theme.visible('tool.args')) return ''
    const shown = limit === undefined ? card.argument : clip(oneLine(card.argument), limit)
    return this.theme.rich(shown, { token: 'tool.args' })
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
    const stats = this.renderStats(card.stats)
    const elapsed = this.elapsedStat(card)
    return { lead, body: `${head}${stats}${elapsed === '' ? '' : `${this.statSeparator()}${elapsed}`}` }
  }

  /**
   * The colour a call's name is drawn in, which is the whole of its state.
   *
   * The name is where a reader looking for a call looks first, so what that call
   * is doing belongs in the name rather than in a glyph beside it: one name, in
   * the colour of its state, and nothing a reader has to learn to read first.
   *
   * A state is only how a name is painted, though, so a reader who turns one of
   * these colours off still gets the name: hiding a state token takes the colour
   * away, not the word it was painted on.
   */
  private titleToken(
    state: { readonly running?: boolean; readonly failed: boolean },
    tokens: { readonly running: TuiToken; readonly failed: TuiToken },
  ): TuiToken {
    if (state.failed) return this.theme.visible(tokens.failed) ? tokens.failed : 'tool.title'
    if (state.running === true) return this.theme.visible(tokens.running) ? tokens.running : 'tool.title'
    return 'tool.title'
  }

  /**
   * The seconds a call has taken: counting while it is unanswered, and kept on
   * the card of a program that dispatched calls.
   *
   * A plain tool's duration is not worth the width once its outcome is on the
   * row, but a program is a thing that took time, and the reader who watched the
   * timer count wants the total it ended on — quietly, since the work is over.
   */
  private elapsedStat(card: ToolCard): string {
    const seconds = card.elapsed ?? 0
    if (seconds < MIN_ELAPSED_SECONDS) return ''
    const token: TuiToken | undefined = card.running === true
      ? 'tool.running.elapsed'
      : this.dispatchedCalls(card)
        ? 'tool.elapsed.done'
        : undefined
    if (token === undefined || !this.theme.visible(token)) return ''
    return this.theme.style(token, `${STAT_SYMBOL.changed}${seconds}s`)
  }

  /**
   * Whether this card drew calls a program dispatched.
   *
   * The child rows are the fold's own statement that the card is a program's, so
   * the view never has to know the name of the tool that runs one.
   */
  private dispatchedCalls(card: ToolCard): boolean {
    return card.subCalls !== undefined
  }

  /**
   * The card as this frame reads it, with its elapsed time filled in.
   *
   * The entry itself is left alone: the rows are cached by entry identity, so
   * rewriting one every second to carry a number that changes every second would
   * discard the rows of a call that has been waiting all along.
   */
  private cardOf(card: ToolCard, live: LiveCallState): ToolCard {
    if (!live.running || card.running === true) return card
    return { ...card, running: true, elapsed: live.elapsed }
  }

  /**
   * Whether any part of one card is still in flight.
   *
   * Only a card with work outstanding has a clock attached to its cache, so the
   * moment the last call settles the row stops being rebuilt: a program that
   * came back must not keep spending the cache its result is now stored in.
   */
  private isLive(entry: TranscriptEntry): boolean {
    if (entry.kind !== 'tool') return false
    // The card's own call is live only while the fold still has it pending: the
    // flag is put on a copy at draw time, so the entry alone cannot answer this.
    // A dispatched call carries its flag on the fold itself, where a settle
    // clears it.
    return this.model.liveCall(entry.id).running || (entry.card.subCalls ?? []).some(call => call.running)
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
      .map(stat => this.theme.rich(`${STAT_SYMBOL[stat.kind]}${stat.text}`, { token: STAT_TOKEN[stat.kind] }))
    if (drawn.length === 0) return ''
    return `${lead}${drawn.join(this.statSeparator())}`
  }

  private pushPicker(lines: string[], picker: PickerCard, width: number): void {
    lines.push('')
    // The rows come from the renderer a popup also draws through, so a card
    // reads the same whether it sits at the end of the transcript or in a box
    // over it, and a field added to a card reaches both at once.
    lines.push(...pickerCardLines(picker, width, this.theme))
  }

  private pushGate(lines: string[], gate: GateCard, width: number): void {
    lines.push('')
    if (this.theme.visible('gate.title')) {
      const glyphToken = gate.kind === 'approval' ? 'gate.glyphApproval' : 'gate.glyphQuestion'
      const glyph = this.theme.glyph(glyphToken) || (gate.kind === 'approval' ? APPROVAL_MARK : QUESTION_MARK)
      // The question is the thing being decided, so it wraps rather than being
      // cut: a reader cannot answer a sentence they were not shown.
      this.pushWrapped(lines, gate.title, width, `${glyph} `, 'gate.title')
    }
    if (this.theme.visible('gate.detail')) {
      for (const detail of gate.detail) {
        this.pushWrapped(lines, detail, width, DETAIL_INDENT, 'gate.detail')
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
      // A surface narrower than the indent cannot place the answer: that row is cut
      // here so what is handed out already fits, rather than being trimmed at the
      // terminal past the point where the view could count it. A row that fits is
      // left exactly as the editor drew it, cursor styling included.
      for (const row of gate.answerInput.render(room)) {
        const placed = `${OPTION_INDENT}${row}`
        lines.push(visibleWidth(placed) <= width ? placed : this.theme.cut(placed, width, ''))
      }
    }
    // The keys are how the gate is answered at all, so they wrap rather than
    // lose their tail at a narrow edge.
    if (this.theme.visible('gate.hint')) {
      this.pushWrapped(lines, gate.hint, width, OPTION_INDENT, 'gate.hint')
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
    // The text reaches pushWrapped undrawn: it is read once there, and reading
    // it twice would show the reader the escape instead of the character.
    this.pushWrapped(lines, text, width, lead, token)
  }

  /** The rows one transcript entry becomes; `live` marks the entry the turn is still writing. */
  private renderEntry(entry: TranscriptEntry, lines: string[], width: number, live: boolean, spans: ClickSpan[], copy: FrameRow[]): void {
    switch (entry.kind) {
      case 'tool':
        this.pushCard(lines, entry, width, spans)
        return
      case 'reasoning':
        this.pushReasoning(lines, entry, width, spans)
        return
      case 'assistant':
        // The reply is boxed the way the prompt that asked for it is, so one
        // exchange reads as two objects rather than as a box and then a stream.
        this.pushFramed(lines, copy, entry.text, width, live, ANSWER_FACE, 'transcript.assistant.border')
        return
      case 'user': {
        if (!this.theme.visible('transcript.user')) return
        // A prompt is boxed wherever it is read, so the row it left in the queue
        // and the row it becomes here are recognisably the same object.
        this.pushFramed(lines, copy, entry.text, width, false, this.userFace(), 'editor.border')
        return
      }
      case 'notice':
        if (!this.theme.visible('transcript.notice')) return
        this.pushWrapped(lines, entry.text, width, this.elementLead('transcript.notice'), 'transcript.notice')
        return
      case 'marker':
        if (!this.theme.visible('transcript.marker')) return
        this.pushWrapped(lines, entry.text, width, this.elementLead('transcript.marker'), 'transcript.marker')
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
    const liveCopy: FrameRow[] = []
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
      // A running row is drawn from a clock the rest of the row is not, so its
      // cache is spent every second: the entries after it stay put, and a card
      // waiting out a two-minute run keeps saying so instead of freezing at the
      // first second it was drawn.
      const tag = `${baseTag}|${marks}${this.isLive(entry) ? `|${Math.floor(this.model.now() / SECOND_MS)}` : ''}`
      const local: ClickSpan[] = []
      const copy: FrameRow[] = []
      // The in-flight rows change on every frame, so caching them would only
      // fill the cache with objects nobody will ask for again.
      if (index >= settled) {
        this.renderEntry(entry, lines, width, true, local, copy)
        // A row still arriving is drawn every frame, so it is never cached: its
        // copy account goes to the frame rather than to an entry nobody can name.
        liveCopy.push(...copy)
        // An in-flight entry draws straight into the transcript, so the spans it
        // recorded already name transcript rows; offsetting them again would move
        // every hit target as many rows down as the entry's own start.
        spans.push(...local)
      } else {
        const cached = this.rows.lookup(entry, tag)
        const saved = this.entrySpans.get(entry)
        const savedCopy = this.entryCopy.get(entry)
        if (cached !== undefined && saved !== undefined && savedCopy !== undefined) {
          lines.push(...cached)
          local.push(...saved)
        } else {
          const rendered: string[] = []
          this.renderEntry(entry, rendered, width, false, local, copy)
          this.rows.store(entry, tag, rendered)
          this.entrySpans.set(entry, local)
          this.entryCopy.set(entry, copy)
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
    this.liveCopy = liveCopy
    const picker = this.options.picker?.()
    if (picker !== undefined) this.pushPicker(lines, picker, width)
    const gate = this.options.gate?.()
    if (gate !== undefined) this.pushGate(lines, gate, width)
    return lines
  }

  /**
   * The framed rows the last render drew, in the order the transcript reads.
   *
   * A copy of a selection is read off the screen, so it carries the frame the
   * surface drew around a message — the sides, the padding beside them, and the
   * rules above and below. This is the account that lets the surface take its own
   * frame back out of a copy without ever touching a character the reader wrote.
   */
  copyRows(): readonly FrameRow[] {
    const rows: FrameRow[] = []
    for (const entry of this.model.entries()) {
      const saved = this.entryCopy.get(entry)
      if (saved !== undefined) rows.push(...saved)
    }
    // The rows still arriving are not kept by entry, so they come from the frame.
    rows.push(...this.liveCopy)
    return rows
  }
}
