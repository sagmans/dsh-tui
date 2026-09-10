/** How one settled line of the transcript reads. */
export type TranscriptKind = 'user' | 'assistant' | 'tool' | 'notice'

/** One renderable transcript row. */
export interface TranscriptEntry {
  readonly kind: TranscriptKind
  readonly text: string
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

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (record === undefined) continue
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join('\n')
}

function sourceKind(data: Record<string, unknown>): string {
  return asRecord(data.source)?.kind === 'user' ? 'user' : 'plugin'
}

/**
 * Fold durable session events into readable rows, and hold the in-flight
 * assistant text apart from them.
 *
 * Durable events own the transcript: the live stream is decoration that a
 * repaint or a resume can drop without changing what the reader sees.
 */
export class TranscriptModel {
  private readonly settled: TranscriptEntry[] = []
  private live = ''

  /** Rows to render, settled text first and the in-flight text last. */
  entries(): readonly TranscriptEntry[] {
    return this.live === ''
      ? this.settled
      : [...this.settled, { kind: 'assistant', text: this.live }]
  }

  /** Whether any row exists, so a caller can decide to clear or redraw. */
  isEmpty(): boolean {
    return this.settled.length === 0 && this.live === ''
  }

  reset(): void {
    this.settled.length = 0
    this.live = ''
  }

  /** Append a surface-local line that is not part of the durable conversation. */
  notice(text: string): void {
    this.settled.push({ kind: 'notice', text })
  }

  /** Apply one transient assistant-stream chunk; text deltas accumulate. */
  applyStreamChunk(chunk: unknown): void {
    const record = asRecord(chunk)
    if (record === undefined) return
    if (record.type === 'text-delta' && typeof record.text === 'string') {
      this.live += record.text
      return
    }
    // A settled attempt supersedes the transient text it streamed.
    if (record.type === 'block-end' && asRecord(record.block)?.type === 'text') this.live = ''
  }

  apply(event: FoldableEvent): void {
    const data = asRecord(event.data) ?? {}
    switch (event.type) {
      case 'user/message': {
        const text = textOfContent(data.content)
        if (text === '') return
        this.settled.push(sourceKind(data) === 'user'
          ? { kind: 'user', text }
          : { kind: 'notice', text })
        return
      }
      case 'assistant/message': {
        const text = textOfContent(asRecord(data.message)?.content)
        this.live = ''
        if (text === '') return
        this.settled.push({ kind: 'assistant', text })
        return
      }
      case 'tool/call': {
        const name = typeof data.name === 'string' ? data.name : 'tool'
        const args = typeof data.arguments === 'string' ? data.arguments : ''
        this.settled.push({ kind: 'tool', text: args === '' ? name : `${name} ${args}` })
        return
      }
      case 'tool/result': {
        const record = asRecord(data.message)
        const text = textOfContent(record?.content)
        const first = text.split('\n')[0] ?? ''
        const failed = record?.isError === true
        this.settled.push({ kind: 'tool', text: failed ? `failed: ${first}` : first })
        return
      }
      default:
        return
    }
  }
}
