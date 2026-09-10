import { mergeCards, type ToolCard, type ToolPresenter } from './cards.ts'

/** One renderable transcript row. */
export type TranscriptEntry =
  | { readonly kind: 'user'; readonly text: string }
  | { readonly kind: 'assistant'; readonly text: string }
  | { readonly kind: 'notice'; readonly text: string }
  | { readonly kind: 'tool'; readonly card: ToolCard }
  | { readonly kind: 'reasoning'; readonly text: string; readonly live: boolean }

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

function sourceKind(data: Record<string, unknown>): string {
  return asRecord(data.source)?.kind === 'user' ? 'user' : 'plugin'
}

function countLines(text: string): number {
  return text === '' ? 0 : text.split('\n').length
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
  private reasoning: { lines: number; chars: number } | undefined

  constructor(private readonly presenter?: ToolPresenter) {}

  /** Rows to render: settled rows, the reasoning row, then the in-flight text. */
  entries(): readonly TranscriptEntry[] {
    const entries = [...this.settled]
    if (this.liveReasoning !== '') {
      entries.push({ kind: 'reasoning', text: `reasoning · ${this.liveReasoning.length} chars`, live: true })
    } else if (this.reasoning !== undefined) {
      entries.push({ kind: 'reasoning', text: `reasoning · ${this.reasoning.lines} lines`, live: false })
    }
    if (this.live !== '') entries.push({ kind: 'assistant', text: this.live })
    return entries
  }

  /** Whether any row exists, so a caller can decide to clear or redraw. */
  isEmpty(): boolean {
    return this.settled.length === 0 && this.live === '' && this.liveReasoning === '' && this.reasoning === undefined
  }

  reset(): void {
    this.settled.length = 0
    this.pending.clear()
    this.live = ''
    this.liveReasoning = ''
    this.reasoning = undefined
  }

  /** Append a surface-local line that is not part of the durable conversation. */
  notice(text: string): void {
    this.settled.push({ kind: 'notice', text })
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
        if (typeof record.text === 'string') this.liveReasoning += record.text
        return
      case 'block-end': {
        const block = asRecord(record.block)
        // A settled block supersedes the transient text it streamed.
        if (block?.type === 'text') this.live = ''
        if (block?.type === 'reasoning') this.settleReasoning()
        return
      }
      default:
        return
    }
  }

  private settleReasoning(): void {
    if (this.liveReasoning === '') return
    this.reasoning = { lines: countLines(this.liveReasoning), chars: this.liveReasoning.length }
    this.liveReasoning = ''
  }

  apply(event: FoldableEvent): void {
    const data = asRecord(event.data) ?? {}
    switch (event.type) {
      case 'user/message': {
        const text = textOfContent(data.content)
        if (text === '') return
        this.settled.push(sourceKind(data) === 'user' ? { kind: 'user', text } : { kind: 'notice', text })
        return
      }
      case 'assistant/message': {
        const text = textOfContent(asRecord(data.message)?.content)
        this.settleReasoning()
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
          card: card ?? { kind: 'generic', title: name, detail: argumentsJson === '' ? [] : [argumentsJson], failed: false, hiddenLines: 0 },
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
        card: result ?? {
          kind: 'generic',
          title: name,
          detail: contentLinesOf(message?.content),
          failed: isError,
          hiddenLines: 0,
        },
      })
      return
    }
    const previous = this.settled[pending.index]
    const call = previous !== undefined && previous.kind === 'tool' ? previous.card : undefined
    if (result === undefined) {
      const base = call ?? { kind: 'generic' as const, title: name, detail: [], hiddenLines: 0 }
      this.settled[pending.index] = { kind: 'tool', card: { ...base, failed: isError } }
      return
    }
    this.settled[pending.index] = { kind: 'tool', card: mergeCards(call, { ...result, failed: isError }) }
  }
}
