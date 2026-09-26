import { RowCache, type RowCacheStats } from './rows.ts'
import { type PickerCard } from './picker.ts'
import { pickerCardLines } from './picker-card.ts'
import { ANSWER_FACE, type MarkdownRenderer } from './markdown.ts'
import { type FrameRow } from './frame.ts'
import { type TuiTheme } from '../theme.ts'
import { type TuiToken } from '../theme-tokens.ts'
import { DEFAULT_TOOL_DISPLAY, type ToolDisplaySpec } from '../tool-display.ts'
import { SECOND_MS } from '../transcript/tool-calls.ts'
import { type TranscriptEntry, type TranscriptModel } from '../transcript.ts'
import { type GateCard } from '../gates.ts'
import { defaultKeymap, hintKeys, type Keymap } from '../input/actions.ts'
import { type Component, type TuiMouseEvent, type TuiMouseEventResult, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import { GateCards } from './view/gate-card.ts'
import { Messages } from './view/transcript-message.ts'
import { ToolCards } from './view/tool-card.ts'

/** What a hint names when the reader has unbound the key it would advertise. */
const REASONING_FOLD_FALLBACK = 'shift+tab'
const CARD_OPEN_FALLBACK = 'ctrl+o'
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
 * the screen. Cards start from the reader's own `tools:` settings, which ship
 * folded — one clipped line each — and a program's calls start folded with them:
 * one line per dispatch is a wall of rows over the answer, and those rows answer
 * to a click on the card's own header or to the nested-calls key.
 */
export const DEFAULT_VIEW_STATE: ViewState = { expandCards: false, expandReasoning: false, expandSubCalls: false }
/**
 * Where one clickable message drew, so a click can find what it landed on.
 *
 * A card's rows cover the calls it dispatched, so the card and each of those
 * calls have a span; the click takes the tightest one it falls in.
 */
/**
 * Where one clickable message drew, so a click can find what it landed on.
 *
 * A card's rows cover the calls it dispatched, so the card and each of those
 * calls have a span; the click takes the tightest one it falls in.
 */
export interface ClickSpan {
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
/**
 * The key one card's own answer about its dispatched calls is remembered under.
 *
 * Beside the card's own key rather than inside it, because the two are different
 * questions: the card's key folds the row, this one says whether the calls under
 * it are worth the rows they cost. A reader who clicked one program's header is
 * answering for that program, and folding a card is not an answer about what it
 * dispatched.
 */
const NESTED_CALLS_CLICK_PREFIX = 'subcalls:'
const nestedCallsClickKey = (id: string): string | undefined => (id === '' ? undefined : `${NESTED_CALLS_CLICK_PREFIX}${id}`)
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
  private readonly cards: ToolCards
  private readonly messages: Messages
  private readonly gates: GateCards
  /** The row renderers, each told only what it draws, so the view stays the one owner of view state and row caches. */

constructor(
    private readonly model: TranscriptModel,
    private readonly theme: TuiTheme,
    private readonly markdown: MarkdownRenderer,
    private readonly options: TranscriptViewOptions = {},
  ) {
    this.cards = new ToolCards({ theme: this.theme, keymap: () => this.keymap(), toolDisplay: tool => this.toolDisplay(tool), expansionOf: entry => this.expansionOf(entry), subCallsOpen: entry => this.subCallsOpen(entry), liveCall: callId => this.model.liveCall(callId), cardOpenHint: () => hintKeys(this.keymap(), 'surface.toolDetail') || CARD_OPEN_FALLBACK, toolKey: id => toolClickKey(id), subCallsKey: id => nestedCallsClickKey(id), subCallKey: (parentId, id) => subCallClickKey(parentId, id), subCallOpen: (parentId, id) => this.subCallOpen(parentId, id) })
    this.messages = new Messages({ theme: this.theme, markdown: this.markdown, reasoningOpen: entry => this.reasoningOpen(entry), reasoningFoldHint: () => this.reasoningFoldHint(), reasoningKey: id => reasoningClickKey(id), pushWrapped: (lines, text, width, prefix, token) => this.pushWrapped(lines, text, width, prefix, token) })
    this.gates = new GateCards({ theme: this.theme, pushWrapped: (lines, text, width, prefix, token) => this.pushWrapped(lines, text, width, prefix, token) })
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
   * Whether one card draws the calls its program dispatched.
   *
   * A click on the card's header outranks the nested-calls key, which stays the
   * one press that shows or hides every program at once; a card nobody clicked
   * follows it. The answer is remembered per card rather than folded into the
   * shared key, because a reader reading one program's work should not have to
   * open every other card in the session to see it.
   *
   * The card's own fold is a different question, answered by a different click:
   * a folded program is one row, and its calls are the work that row summarised
   * — which is what a reader unrolls it for, whether or not the program's own
   * return value is on screen with them.
   */
  private subCallsOpen(entry: Extract<TranscriptEntry, { kind: 'tool' }>): boolean {
    if (entry.card.subCalls === undefined) return false
    const key = nestedCallsClickKey(entry.id)
    const clicked = key === undefined ? undefined : this.clicked.get(key)
    return clicked ?? this.viewState.expandSubCalls
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
    // One click on a program's header opens the one level under it: the calls the
    // program dispatched, each still the single row it is read at. The program's
    // own body is the level below that, and it stays folded here because a click
    // that drew both would spend rows the reader never asked for, with nothing
    // left to click for less. Ctrl+O is what opens a card's own rows.
    if (span.key.startsWith(NESTED_CALLS_CLICK_PREFIX)) {
      this.clicked.set(span.key, this.clicked.get(span.key) !== true)
      return { handled: true, render: true }
    }
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
/** The live map, or the shipped one for a caller that did not lend one. */
  private keymap(): Keymap {
    return this.options.keys?.() ?? defaultKeymap()
  }
private reasoningFoldHint(): string {
    return hintKeys(this.keymap(), 'surface.reasoning') || REASONING_FOLD_FALLBACK
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
private pushPicker(lines: string[], picker: PickerCard, width: number): void {
    lines.push('')
    // The rows come from the renderer a popup also draws through, so a card
    // reads the same whether it sits at the end of the transcript or in a box
    // over it, and a field added to a card reaches both at once.
    lines.push(...pickerCardLines(picker, width, this.theme))
  }
/** The rows one transcript entry becomes; `live` marks the entry the turn is still writing. */
  private renderEntry(entry: TranscriptEntry, lines: string[], width: number, live: boolean, spans: ClickSpan[], copy: FrameRow[]): void {
    switch (entry.kind) {
      case 'tool':
        this.cards.pushCard(lines, entry, width, spans)
        return
      case 'reasoning':
        this.messages.pushReasoning(lines, entry, width, spans)
        return
      case 'assistant':
        // The reply is boxed the way the prompt that asked for it is, so one
        // exchange reads as two objects rather than as a box and then a stream.
        this.messages.pushFramed(lines, copy, entry.text, width, live, ANSWER_FACE, 'transcript.assistant.border')
        return
      case 'user': {
        if (!this.theme.visible('transcript.user')) return
        // A sent prompt keeps its frame without inheriting changes to the input bar.
        this.messages.pushFramed(lines, copy, entry.text, width, false, this.messages.userFace(), 'transcript.user.border')
        return
      }
      case 'notice':
        if (!this.theme.visible('transcript.notice')) return
        this.pushWrapped(lines, entry.text, width, this.messages.elementLead('transcript.notice'), 'transcript.notice')
        return
      case 'marker':
        if (!this.theme.visible('transcript.marker')) return
        this.pushWrapped(lines, entry.text, width, this.messages.elementLead('transcript.marker'), 'transcript.marker')
        return
    }
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
      // Whether a program's calls are drawn is part of the key, because it moves
      // rows the card's own fold does not: the calls come and go under a header
      // that stays where it is, and a cached entry would keep answering with what
      // the reader had already clicked away from.
      const shape = entry.kind === 'tool' && this.subCallsOpen(entry) ? 'P' : 'p'
      const marks = entry.kind === 'tool'
        ? `${open === true ? '+' : '-'}${shape}${(entry.card.subCalls ?? []).map(call => (this.subCallOpen(entry.id, call.id) ? '1' : '0')).join('')}`
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
          spans.push({ ...span, start: span.start + start, end: span.end + start })
        }
      }
    }
    this.spans = spans
    this.liveCopy = liveCopy
    const picker = this.options.picker?.()
    if (picker !== undefined) this.pushPicker(lines, picker, width)
    const gate = this.options.gate?.()
    if (gate !== undefined) this.gates.pushGate(lines, gate, width)
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
