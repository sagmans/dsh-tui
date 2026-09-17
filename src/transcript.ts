import { cardFromLines, mergeCards, type ToolCard, type ToolPresenter } from './cards.ts'

/** One renderable transcript row. */
export type TranscriptEntry =
  | { readonly kind: 'user'; readonly text: string }
  | { readonly kind: 'assistant'; readonly text: string }
  | { readonly kind: 'notice'; readonly text: string }
  | { readonly kind: 'marker'; readonly text: string }
  | { readonly kind: 'tool'; readonly card: ToolCard }
  | { readonly kind: 'reasoning'; readonly summary: string; readonly body: string; readonly live: boolean }

/** Reasoning kept per settled block, so one runaway thought cannot grow the transcript without bound. */
export const REASONING_CHAR_LIMIT = 20_000

/**
 * Characters a provider bills as one token.
 *
 * The exact count needs the tokenizer the provider used, which a terminal does
 * not have; four characters per token is the estimate a reader can compare
 * against, and it is the unit they spend rather than lines or characters.
 */
export const CHARS_PER_TOKEN = 4

/** A thought's size in tokens, rounded up so a non-empty thought never reads as zero. */
export function countTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

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
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
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
 * Summarize an injected context block.
 *
 * Injected instructions can be thousands of lines and are rewritten by the
 * model, not read by the human, so the row names the producer and its size and
 * keeps one line of preview instead of pushing the conversation off screen.
 */
function injectionSummary(data: Record<string, unknown>, text: string): string {
  const source = asRecord(data.source) ?? {}
  const plugin = typeof source.plugin === 'string' ? source.plugin : 'plugin'
  const lines = text.split('\n').filter(line => line.trim() !== '')
  const first = lines[0]?.trim() ?? ''
  const preview = first.length > 72 ? `${first.slice(0, 71)}…` : first
  return `injected ${plugin} · ${lines.length} lines${preview === '' ? '' : ` — ${preview}`}`
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

  constructor(
    private readonly presenter?: ToolPresenter,
    /** Clock for "how long has this been thinking"; injected so a test can pin it. */
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Rows to render: settled rows, the in-flight reasoning, then the in-flight text. */
  entries(): readonly TranscriptEntry[] {
    const entries = [...this.settled]
    if (this.liveReasoning !== '') {
      const ranFor = this.reasoningStartedAt === undefined ? undefined : this.now() - this.reasoningStartedAt
      entries.push({
        kind: 'reasoning',
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

  /** Whether any row exists, so a caller can decide to clear or redraw. */
  isEmpty(): boolean {
    return this.settled.length === 0 && this.live === '' && this.liveReasoning === ''
  }

  reset(): void {
    this.settled.length = 0
    this.pending.clear()
    this.live = ''
    this.liveReasoning = ''
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
        this.reasoningStartedAt ??= this.now()
        this.liveReasoning += record.text
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
    const cut = text.length > REASONING_CHAR_LIMIT ? `\n… truncated at ${REASONING_CHAR_LIMIT} chars` : ''
    this.settled.push({
      kind: 'reasoning',
      summary: `reasoning · ${describeTokens(text)}${timing}`,
      body: text.slice(0, REASONING_CHAR_LIMIT) + cut,
      live: false,
    })
    this.reasoningPaintedThisStep = true
  }

  /** Settle the reasoning streamed so far into a row of its own. */
  private settleReasoning(): void {
    if (this.liveReasoning === '') return
    const text = this.liveReasoning
    const ranFor = this.reasoningStartedAt === undefined ? undefined : this.now() - this.reasoningStartedAt
    this.liveReasoning = ''
    this.reasoningStartedAt = undefined
    this.paintReasoning(text, ranFor)
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
        const card = this.presenter?.call(name, argumentsJson)
        this.settled.push({
          kind: 'tool',
          // Without a presenter the row still has to say what ran and with what.
          card: card ?? cardFromLines('generic', name, argumentsJson === '' ? [] : argumentsJson.split('\n'), false),
        })
        const callId = typeof data.callId === 'string' ? data.callId : ''
        if (callId !== '') this.pending.set(callId, { name, argumentsJson, index: this.settled.length - 1 })
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

  private settleToolResult(data: Record<string, unknown>): void {
    const message = asRecord(data.message)
    const firstBlock = Array.isArray(message?.content) ? asRecord(message.content[0]) : undefined
    const callId = typeof firstBlock?.toolCallId === 'string' ? firstBlock.toolCallId : ''
    const pending = callId === '' ? undefined : this.pending.get(callId)
    if (callId !== '') this.pending.delete(callId)
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
        card: result ?? cardFromLines('generic', name, contentLinesOf(message?.content), isError),
      })
      return
    }
    const previous = this.settled[pending.index]
    const call = previous !== undefined && previous.kind === 'tool' ? previous.card : undefined
    if (result === undefined) {
      // No presenter answered: the model-facing content is still what happened,
      // and a reader without it would see a tool row that never reported back.
      const reported = contentLinesOf(message?.content)
      const base = call ?? cardFromLines('generic', name, [], false)
      const rebuilt = reported.length === 0
        ? { ...base, failed: isError }
        : { ...cardFromLines(base.kind, base.title, reported, isError), ...(base.command === undefined ? {} : { command: base.command }) }
      this.settled[pending.index] = { kind: 'tool', card: rebuilt }
      return
    }
    this.settled[pending.index] = { kind: 'tool', card: mergeCards(call, { ...result, failed: isError }) }
  }
}
