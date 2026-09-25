import type { ToolCard, ToolPresenter } from './cards.ts'
import { injectionSummary } from './injection.ts'
import { sliceGraphemes, tailGraphemes } from './text.ts'
import { countTokens } from './tokens.ts'
import { reasoningTextsOf, textOfContent } from './transcript/message-content.ts'
import { ToolCallFold, type LiveCallState, type ToolCallOutcome } from './transcript/tool-calls.ts'

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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
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
 * name; the bookkeeping that a tool row's request, dispatch, and result share
 * lives in the call fold this model routes those events to.
 */
export class TranscriptModel {
  private readonly settled: TranscriptEntry[] = []
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
  /** The call-to-row bookkeeping tool events share, told the clock and the rows this model holds. */
  private readonly calls: ToolCallFold

  constructor(
    presenter?: ToolPresenter,
    /**
     * Clock for "how long has this been thinking or running"; injected so a test
     * can pin it and reachable through {@link now} so a renderer keys its rows
     * to the same one.
     */
    private readonly clock: () => number = () => Date.now(),
  ) {
    this.calls = new ToolCallFold(presenter, clock, index => this.cardAt(index))
  }

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
   * The call fold owns the request-to-result window, so a renderer asks here
   * rather than timing the row itself: a row read twice in one frame would
   * otherwise report two durations for one call.
   */
  liveCall(callId: string): LiveCallState {
    return this.calls.liveCall(callId)
  }

  /** Whether any row exists, so a caller can decide to clear or redraw. */
  isEmpty(): boolean {
    return this.settled.length === 0 && this.live === '' && this.liveReasoning === ''
  }

  reset(): void {
    this.settled.length = 0
    // The call fold's records name rows of the transcript being dropped, so the
    // fold is reset with it rather than left holding stale row indices.
    this.calls.reset()
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
      case 'tool/call':
      case 'tool/ptc-dispatch-start':
      case 'tool/ptc-dispatch':
      case 'tool/result': {
        // Tool events are the only rows drawn before they are finished, so they
        // are folded where that bookkeeping lives and the rows come back here,
        // where reading order and row indices are owned.
        this.commit(this.calls.apply(event.type, data, this.settled.length))
        return
      }
      default:
        return
    }
  }

  /** Commit the rows the call fold drew: appends in order, replacements in place. */
  private commit(outcome: ToolCallOutcome): void {
    for (const entry of outcome.appends) this.settled.push(entry)
    for (const { index, entry } of outcome.replacements) this.settled[index] = entry
  }

  /** The card a settled tool row holds, so the call fold can restate a row it drew earlier. */
  private cardAt(index: number): ToolCard | undefined {
    const entry = this.settled[index]
    return entry !== undefined && entry.kind === 'tool' ? entry.card : undefined
  }
}
