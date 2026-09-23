import { cardFromLines, carriedFields, contentLines, mergeCards, subCallRow, subCallRows, SUBCALL_MAX, type ToolCard, type ToolPresenter, type ToolSubCallRows } from './cards.ts'
import { injectionSummary } from './injection.ts'
import { sliceGraphemes, tailGraphemes } from './text.ts'
import { countTokens } from './tokens.ts'

/** One renderable transcript row. */
export type TranscriptEntry =
  | { readonly kind: 'user'; readonly text: string }
  | { readonly kind: 'assistant'; readonly text: string }
  | { readonly kind: 'notice'; readonly text: string }
  | { readonly kind: 'marker'; readonly text: string }
  | { readonly kind: 'tool'; readonly card: ToolCard; readonly id: string }
  | { readonly kind: 'reasoning'; readonly id: string; readonly summary: string; readonly body: string; readonly live: boolean }

/** Reasoning kept per settled block, so one runaway thought cannot grow the transcript without bound. */
export const REASONING_CHAR_LIMIT = 20_000

/**
 * How far a live thought may grow past that budget before its head is dropped.
 *
 * The slice itself is linear, so a burst of slack makes it happen once per
 * thought rather than on every delta that crosses the limit.
 */
const LIVE_THOUGHT_SLACK = 2

/** One second in milliseconds, which is the unit a duration is reported in. */
export const SECOND_MS = 1000

/** The token count with its noun, because "1 tokens" reads as a bug. */
function describeTokens(text: string): string {
  const tokens = countTokens(text)
  return `${tokens} token${tokens === 1 ? '' : 's'}`
}

/**
 * Minimal durable-input shape the fold needs.
 *
 * The fold reads events structurally instead of importing a large event union:
 * a terminal frontend only interprets the few fields it renders, and staying
 * structural keeps this file pure and testable without a live session.
 */
export interface FoldableEvent {
  readonly type: string
  readonly data?: unknown
}

interface PendingCall {
  readonly name: string
  readonly argumentsJson: string
  readonly index: number
  /**
   * When the call was requested, which is the only clock a running card has.
   *
   * The log carries no execution-start event for a tool, so the request is the
   * earliest moment the surface can call the call in flight — and the elapsed
   * time it shows a reader has to be measured from there.
   */
  readonly startedAt: number
  /** Sub-calls this call dispatched, so its settle can drop their bookkeeping. */
  readonly subs: string[]
}

/**
 * What is known about one call the fold has seen requested and not answered.
 *
 * A settled call reads as nothing rather than as a zero elapsed time: "started
 * now" and "waiting an unknown time" are different things to say, and only the
 * fold can tell which one is true.
 */
export interface LiveCallState {
  readonly running: boolean
  readonly elapsed: number
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/** The arguments a nested call was made with, as the shape a presenter is asked with. */
function argumentsJsonOf(value: unknown): string {
  if (value === undefined) return ''
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

function contentLinesOf(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  const lines: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (record === undefined) continue
    // A thought is a row of its own; reading it here would hand the model's
    // private reasoning to the reader as though it had been said out loud.
    if (record.type === 'reasoning') continue
    // Any block that carries text counts; a tool-result block also holds its
    // model-facing content one level deeper.
    if (typeof record.text === 'string') lines.push(...record.text.split('\n'))
    if (Array.isArray(record.content)) lines.push(...contentLinesOf(record.content))
  }
  return lines
}

function textOfContent(content: unknown): string {
  return contentLinesOf(content).join('\n')
}

/**
 * The thoughts a durable message carries, in the order they were recorded.
 *
 * A recorded thought is the only path a resumed session has to the model's
 * reasoning, and the live stream does not outlive the turn that produced it.
 */
function reasoningTextsOf(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  const thoughts: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (record === undefined) continue
    if (record.type === 'reasoning' && typeof record.text === 'string') thoughts.push(record.text)
    if (Array.isArray(record.content)) thoughts.push(...reasoningTextsOf(record.content))
  }
  return thoughts
}

function sourceKind(data: Record<string, unknown>): string {
  return asRecord(data.source)?.kind === 'user' ? 'user' : 'plugin'
}

function messageOf(value: unknown): string {
  const record = asRecord(value)
  if (record === undefined) return ''
  if (typeof record.message === 'string') return record.message
  if (typeof record.code === 'string') return record.code
  return ''
}

/**
 * Fold durable session events into readable rows, and hold the in-flight
 * assistant text and reasoning apart from them.
 *
 * Durable events own the transcript: the live stream is decoration that a
 * repaint or a resume can drop without changing what the reader sees. Tool
 * rows come from the tool's own render intent, so the fold never learns a tool
 * name.
 */
export class TranscriptModel {
  private readonly settled: TranscriptEntry[] = []
  private readonly pending = new Map<string, PendingCall>()
  /**
   * Where each nested call landed on its root card.
   *
   * A dispatch logs a start and then a settle, so the second event has to find
   * the row the first one drew instead of adding a second line for one call.
   */
  private readonly pendingSub = new Map<string, { readonly rootIndex: number; readonly childIndex: number }>()
  private live = ''
  private liveReasoning = ''
  private reasoningStartedAt: number | undefined
  /**
   * Whether this step already painted a thought from the stream.
   *
   * A live turn streams the thinking and then records the same text in the
   * message, so the recorded copy is a repeat rather than a second thought.
   */
  private reasoningPaintedThisStep = false
  /**
   * Ids for thought rows, and the id the live thought will settle under.
   *
   * The counter never restarts: a click outlives the entry it was made on, and
   * a reused id would hand that choice to a later session's thought.
   */
  private thoughtSeq = 0
  private liveReasoningId: string | undefined

  constructor(
    private readonly presenter?: ToolPresenter,
    /**
     * Clock for "how long has this been thinking or running"; injected so a test
     * can pin it and reachable through {@link now} so a renderer keys its rows
     * to the same one.
     */
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /**
   * The clock every duration on a row is measured with.
   *
   * A renderer that caches rows has to know when a running row's duration would
   * have changed, and reading the same clock the fold timed the call with is the
   * only way for the number on screen and the cache key to agree.
   */
  now(): number {
    return this.clock()
  }

  /** Rows to render: settled rows, the in-flight reasoning, then the in-flight text. */
  entries(): readonly TranscriptEntry[] {
    const entries = [...this.settled]
    if (this.liveReasoning !== '') {
      const ranFor = this.reasoningStartedAt === undefined ? undefined : this.clock() - this.reasoningStartedAt
      entries.push({
        kind: 'reasoning',
        // The live row and the row it settles into share an id, so a click made
        // while the model is still thinking survives the thought landing.
        id: this.liveReasoningId ?? '',
        summary: `reasoning · ${describeTokens(this.liveReasoning)}${ranFor === undefined ? '' : ` · ${Math.max(1, Math.round(ranFor / 1000))}s`} · streaming`,
        body: this.liveReasoning,
        live: true,
      })
    }
    if (this.live !== '') entries.push({ kind: 'assistant', text: this.live })
    return entries
  }

  /**
   * How many rows are settled.
   *
   * Rows after this are the in-flight ones, rebuilt on every frame anyway, so a
   * renderer can keep its cache to the part of the transcript that stopped
   * changing.
   */
  settledCount(): number {
    return this.settled.length
  }

  /**
   * How long one call has been in flight, or that it is not.
   *
   * The fold owns the request-to-result window, so a renderer asks here rather
   * than timing the row itself: a row read twice in one frame would otherwise
   * report two durations for one call.
   */
  liveCall(callId: string): LiveCallState {
    const call = callId === '' ? undefined : this.pending.get(callId)
    if (call === undefined) return { running: false, elapsed: 0 }
    return { running: true, elapsed: this.secondsSince(call.startedAt) }
  }

  /**
   * Whole seconds since a moment the fold read the clock at.
   *
   * Floored, not rounded: a duration that claims a second it has not waited yet
   * would tick up before the call has been waiting that long.
   */
  private secondsSince(startedAt: number): number {
    return Math.max(0, Math.floor((this.clock() - startedAt) / SECOND_MS))
  }

  /** Whether any row exists, so a caller can decide to clear or redraw. */
  isEmpty(): boolean {
    return this.settled.length === 0 && this.live === '' && this.liveReasoning === ''
  }

  reset(): void {
    this.settled.length = 0
    this.pending.clear()
    // The sub-call bookkeeping names rows of the fold being dropped, so it goes
    // with them: an index kept across the reset would refuse a replayed call the
    // row it is entitled to.
    this.pendingSub.clear()
    this.live = ''
    this.liveReasoning = ''
    this.liveReasoningId = undefined
    this.reasoningStartedAt = undefined
    this.reasoningPaintedThisStep = false
  }

  /** Append a surface-local line that is not part of the durable conversation. */
  notice(text: string): void {
    this.settled.push({ kind: 'notice', text })
  }

  /** Mark a boundary in the conversation: compaction, or work that ran elsewhere. */
  marker(text: string): void {
    this.settled.push({ kind: 'marker', text })
  }

  /** Apply one transient assistant-stream chunk. */
  applyStreamChunk(chunk: unknown): void {
    const record = asRecord(chunk)
    if (record === undefined) return
    switch (record.type) {
      case 'text-delta':
        if (typeof record.text === 'string') this.live += record.text
        return
      case 'reasoning-delta':
        if (typeof record.text !== 'string') return
        this.reasoningStartedAt ??= this.clock()
        this.liveReasoningId ??= String(++this.thoughtSeq)
        this.liveReasoning += record.text
        // A live thought is not bounded until the block it belongs to ends, and
        // every frame re-wraps what this holds: past a burst of slack the head is
        // dropped in one step, so a runaway thought costs a bounded wrap per frame
        // instead of a growing one. The recorded text, not this, is what settles.
        if (this.liveReasoning.length > REASONING_CHAR_LIMIT * LIVE_THOUGHT_SLACK) {
          this.liveReasoning = tailGraphemes(this.liveReasoning, REASONING_CHAR_LIMIT)
        }
        return
      case 'block-end': {
        const block = asRecord(record.block)
        // A settled reasoning block becomes a row now. A settled text block keeps
        // its streamed text on screen, because dropping it would blank the answer
        // on every repaint until the recorded message arrives.
        if (block?.type === 'reasoning') this.settleReasoning()
        return
      }
      default:
        return
    }
  }

  /** Report why a turn ended, except for the ordinary completion the reader already sees. */
  private reportTurnEnd(reason: Record<string, unknown>): void {
    const kind = typeof reason.kind === 'string' ? reason.kind : 'completed'
    if (kind === 'completed') return
    if (kind === 'error') {
      const failure = messageOf(reason.error)
      this.settled.push({ kind: 'notice', text: `turn failed: ${failure === '' ? 'model request failed' : failure}` })
      return
    }
    if (kind === 'aborted') {
      const cause = asRecord(reason.reason)
      const by = typeof cause?.kind === 'string' ? cause.kind : 'user'
      this.settled.push({ kind: 'notice', text: `turn aborted (${by})` })
      return
    }
    this.settled.push({ kind: 'notice', text: `turn ended: ${kind}` })
  }

  /** Report a live agent failure the durable log never carries as a message. */
  reportError(error: unknown): void {
    const text = error instanceof Error ? error.message : messageOf(error)
    this.settled.push({ kind: 'notice', text: `error: ${text === '' ? 'agent failed' : text}` })
  }

  /**
   * Settle one thought into a row of its own.
   *
   * The row lands where the reasoning happened, which is before the answer it
   * produced, so reading order still matches the order the model thought in.
   */
  private paintReasoning(text: string, ranFor: number | undefined): void {
    const timing = ranFor === undefined ? '' : ` · ${Math.max(1, Math.round(ranFor / 1000))}s`
    const kept = sliceGraphemes(text, REASONING_CHAR_LIMIT)
    const cut = kept.length === text.length ? '' : `\n… truncated at ${REASONING_CHAR_LIMIT} chars`
    // The live thought keeps the id the stream gave it; a thought only the
    // recorded message carries takes the next one.
    const id = this.liveReasoningId ?? String(++this.thoughtSeq)
    this.liveReasoningId = undefined
    this.settled.push({
      kind: 'reasoning',
      id,
      summary: `reasoning · ${describeTokens(text)}${timing}`,
      body: kept + cut,
      live: false,
    })
  }

  /** Settle the reasoning streamed so far into a row of its own. */
  private settleReasoning(): void {
    if (this.liveReasoning === '') return
    const text = this.liveReasoning
    const ranFor = this.reasoningStartedAt === undefined ? undefined : this.clock() - this.reasoningStartedAt
    this.liveReasoning = ''
    this.reasoningStartedAt = undefined
    this.paintReasoning(text, ranFor)
    // This thought arrived as a stream, so the recorded copy the step ends with
    // restates it rather than reporting a second one.
    this.reasoningPaintedThisStep = true
  }

  apply(event: FoldableEvent): void {
    const data = asRecord(event.data) ?? {}
    switch (event.type) {
      case 'user/message': {
        const text = textOfContent(data.content)
        if (text === '') return
        this.settled.push(sourceKind(data) === 'user'
          ? { kind: 'user', text }
          : { kind: 'notice', text: injectionSummary(data, text) })
        return
      }
      case 'turn/end': {
        this.reportTurnEnd(asRecord(data.reason) ?? {})
        // A turn that ended without a recorded message must not leave streamed
        // text on screen as though it had settled.
        this.live = ''
        // The same goes for the thought that was streaming: left in place it
        // would stay live across the gap and the next turn's deltas would be
        // appended to a thought that turn never had.
        this.liveReasoning = ''
        this.liveReasoningId = undefined
        this.reasoningStartedAt = undefined
        // A step that ended without a message cannot own the next one's thoughts.
        this.reasoningPaintedThisStep = false
        return
      }
      case 'agent-preset/selected': {
        // The log records the composition later turns ran under, so a reader
        // who switched modes sees where the switch happened.
        const selected = typeof data.agentPreset === 'string' ? data.agentPreset : ''
        if (selected !== '') this.marker(`preset → ${selected}`)
        return
      }
      case 'compaction/start': {
        this.marker('compacting the conversation')
        return
      }
      case 'compaction/summary': {
        const events = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.length : 0
        const tokens = typeof data.shadowedTokenCount === 'number' ? data.shadowedTokenCount : undefined
        const size = tokens === undefined ? '' : ` (≈${tokens} tokens)`
        // The summary itself arrives as the user/message that follows, so this
        // row only has to explain where the older history went.
        this.marker(`compacted ${events} events${size}`)
        return
      }
      case 'assistant/attempt': {
        // An attempt that settled without a message still has to explain itself.
        const failure = data.error === undefined ? '' : messageOf(data.error)
        if (failure !== '') this.settled.push({ kind: 'notice', text: `request failed: ${failure}` })
        return
      }
      case 'assistant/message': {
        const content = asRecord(data.message)?.content
        const text = textOfContent(content)
        // Settle whatever the stream held, then decide whether the recorded
        // thoughts are news or the same step arriving twice.
        this.settleReasoning()
        const painted = this.reasoningPaintedThisStep
        this.reasoningPaintedThisStep = false
        if (!painted) {
          for (const thought of reasoningTextsOf(content)) this.paintReasoning(thought, undefined)
        }
        this.live = ''
        if (text !== '') this.settled.push({ kind: 'assistant', text })
        return
      }
      case 'tool/call': {
        const name = typeof data.name === 'string' ? data.name : 'tool'
        const argumentsJson = typeof data.arguments === 'string' ? data.arguments : ''
        const callId = typeof data.callId === 'string' ? data.callId : ''
        const card = this.presenter?.call(name, argumentsJson)
        this.settled.push({
          kind: 'tool',
          // The id is what keeps a reader's click on this message after the
          // result replaces the card: the entry object does not survive, the id does.
          id: callId,
          // Without a presenter the row still has to say what ran and with what.
          card: card ?? cardFromLines('generic', name, name, argumentsJson === '' ? [] : argumentsJson.split('\n'), false),
        })
        if (callId !== '') this.pending.set(callId, { name, argumentsJson, index: this.settled.length - 1, startedAt: this.clock(), subs: [] })
        return
      }
      case 'tool/ptc-dispatch-start': {
        this.applySubCall(data, false)
        return
      }
      case 'tool/ptc-dispatch': {
        this.applySubCall(data, true)
        return
      }
      case 'tool/result': {
        this.settleToolResult(data)
        return
      }
      default:
        return
    }
  }

  /**
   * Fold one nested PTC call onto the card of the run_code call that dispatched it.
   *
   * Dispatches are logged while the program runs, so the root is still pending;
   * a dispatch whose root is not in this fold belongs to a window that starts
   * mid-run, and attaching it to another card would claim a call that card
   * never made.
   */
  private applySubCall(data: Record<string, unknown>, settled: boolean): void {
    const rootCallId = typeof data.rootCallId === 'string' ? data.rootCallId : ''
    const subCallId = typeof data.subCallId === 'string' ? data.subCallId : ''
    const root = rootCallId === '' ? undefined : this.pending.get(rootCallId)
    if (root === undefined || subCallId === '') return
    const entry = this.settled[root.index]
    const card = entry !== undefined && entry.kind === 'tool' ? entry.card : undefined
    if (card === undefined) return
    const name = typeof data.name === 'string' ? data.name : 'tool'
    const argumentsJson = argumentsJsonOf(data.arguments)
    // The call's own view is asked for once: it names the row and it is what the
    // row shows of the call itself, so two asks could disagree about one call.
    const view = this.presenter?.call(name, argumentsJson)
    const isError = data.isError === true
    const result = settled ? this.subCallResult(name, argumentsJson, data, view) : undefined
    const output = result === undefined ? undefined : subCallRows(result)
    // A call that answered has told the surface how it went, and that is what the
    // row reports from then on — a program's calls are read by their outcomes.
    const failed = settled && (isError || result?.failed === true)
    const known = this.pendingSub.get(subCallId)
    if (known !== undefined) {
      // A settle restates the row its start drew: it ends the claim that the
      // call is still in flight, adds the outcome a reader opens the row for, and
      // a failure takes back what the call only declared. A call that produced
      // nothing to open still has to be restated, or its row would keep saying it
      // is running for as long as the card lives.
      if (!settled || known.childIndex < 0) return
      const drawn = (card.subCalls ?? [])[known.childIndex]
      if (!isError && output === undefined && drawn?.running !== true) return
      // A settle that reports nothing to open leaves the row's own outcome in
      // place; only a failure takes it back, because the rows it drew as applied
      // never happened.
      const settledOutput = isError ? output : output ?? drawn?.output
      const subCalls = (card.subCalls ?? []).map((call, at) => at === known.childIndex
        ? subCallRow(subCallId, name, argumentsJson, { view, output: settledOutput, status: result?.status, running: false, failed }, call)
        : call)
      this.settled[root.index] = { kind: 'tool', id: rootCallId, card: { ...card, subCalls } }
      return
    }
    // A dispatch log arrives only once the call has settled, so a row that no
    // settle has restated yet is the one still running.
    const call = subCallRow(subCallId, name, argumentsJson, { view, output, status: result?.status, running: !settled, failed })
    const kept = card.subCalls ?? []
    const total = (card.subCallsTotal ?? 0) + 1
    if (kept.length >= SUBCALL_MAX) {
      // Retention keeps the head, where the calls that shaped the program are;
      // the count still reports everything it dispatched. The id is remembered
      // so a settle is not counted twice, and listed on the root so the root's
      // own cleanup forgets it — an overflow row has no row to clean up after.
      this.pendingSub.set(subCallId, { rootIndex: root.index, childIndex: -1 })
      root.subs.push(subCallId)
      this.settled[root.index] = { kind: 'tool', id: rootCallId, card: { ...card, subCallsTotal: total } }
      return
    }
    root.subs.push(subCallId)
    this.pendingSub.set(subCallId, { rootIndex: root.index, childIndex: kept.length })
    this.settled[root.index] = { kind: 'tool', id: rootCallId, card: { ...card, subCalls: [...kept, call], subCallsTotal: total } }
  }

  /**
   * The card a dispatched call's log answers with.
   *
   * A presenter can only rebuild the view it declared when the logged content is
   * enough for it: a shell's output is, while a read's numbered window and a
   * search's hits live in the metadata a dispatch does not carry. The fallback is
   * the content the program was actually shown, so a row whose tool cannot be
   * re-presented still opens to its outcome rather than to nothing.
   */
  private subCallResult(
    name: string,
    argumentsJson: string,
    data: Record<string, unknown>,
    view: ToolCard | undefined,
  ): ToolCard {
    const failed = data.isError === true
    return this.presenter?.result(name, { argumentsJson, content: data.content, isError: failed, meta: data.meta })
      ?? cardFromLines(view?.kind ?? 'generic', name, view?.title ?? name, contentLines(data.content), failed)
  }

  private settleToolResult(data: Record<string, unknown>): void {
    const message = asRecord(data.message)
    const firstBlock = Array.isArray(message?.content) ? asRecord(message.content[0]) : undefined
    const callId = typeof firstBlock?.toolCallId === 'string' ? firstBlock.toolCallId : ''
    const pending = callId === '' ? undefined : this.pending.get(callId)
    if (callId !== '') this.pending.delete(callId)
    // The length of the run is readable here and nowhere else: the surface saw
    // the call logged and now sees it answered, and this is the only moment the
    // fold holds both readings of the clock.
    const ranFor = pending === undefined ? undefined : this.secondsSince(pending.startedAt)
    /** The card that reports this result, carrying the seconds the call took. */
    const finished = (card: ToolCard): ToolCard => (ranFor === undefined ? card : { ...card, elapsed: ranFor })
    // The root is done dispatching, so its bookkeeping goes with it; the rows it
    // already drew stay on the card.
    if (pending !== undefined) for (const sub of pending.subs) this.pendingSub.delete(sub)
    const name = pending?.name ?? 'tool'
    const isError = message?.isError === true
    const result = this.presenter?.result(name, {
      argumentsJson: pending?.argumentsJson ?? '',
      content: message?.content,
      isError,
      meta: data.meta,
    })
    if (pending === undefined) {
      // No matching call in this fold: a resumed transcript may start mid-call.
      this.settled.push({
        kind: 'tool',
        id: callId,
        card: result ?? cardFromLines('generic', name, name, contentLinesOf(message?.content), isError),
      })
      return
    }
    const previous = this.settled[pending.index]
    const call = previous !== undefined && previous.kind === 'tool' ? previous.card : undefined
    if (result === undefined) {
      // No presenter answered: the model-facing content is still what happened,
      // and a reader without it would see a tool row that never reported back.
      const reported = contentLinesOf(message?.content)
      const base = call ?? cardFromLines('generic', name, name, [], false)
      const rebuilt = reported.length === 0
        ? { ...base, failed: isError }
        : { ...cardFromLines(base.kind, base.tool, base.title, reported, isError), ...carriedFields(base) }
      this.settled[pending.index] = { kind: 'tool', id: callId, card: finished(rebuilt) }
      return
    }
    this.settled[pending.index] = { kind: 'tool', id: callId, card: finished(mergeCards(call, { ...result, failed: isError })) }
  }
}
