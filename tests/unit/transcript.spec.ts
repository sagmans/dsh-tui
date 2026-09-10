import { describe, expect, it } from 'vitest'
import { type ToolCard, type ToolPresenter } from '@/cards.ts'
import { TranscriptModel } from '@/transcript.ts'

const text = (value: string) => [{ type: 'text', text: value }]

const card = (title: string, detail: string[] = []): ToolCard =>
  ({ kind: 'generic', title, detail, failed: false, hiddenLines: 0 })

/** Presenter that records what it was asked, so pairing can be asserted. */
function recordingPresenter(): ToolPresenter & { readonly calls: string[]; readonly results: string[] } {
  const calls: string[] = []
  const results: string[] = []
  return {
    calls,
    results,
    call(name, argumentsJson) {
      calls.push(`${name}:${argumentsJson}`)
      return card(`${name} pending`, ['from presenter'])
    },
    result(name, input) {
      results.push(`${name}:${input.argumentsJson}:${input.isError ? 'error' : 'ok'}`)
      return card(`${name} settled`, ['result line'])
    },
  }
}

describe('TranscriptModel rows', () => {
  it('renders a human prompt as a user row', () => {
    const model = new TranscriptModel()
    model.apply({ type: 'user/message', data: { content: text('hello'), source: { kind: 'user' } } })
    expect(model.entries()).toEqual([{ kind: 'user', text: 'hello' }])
  })

  it('names the producer of injected context instead of quoting it', () => {
    const model = new TranscriptModel()
    model.apply({ type: 'user/message', data: { content: text('context'), source: { kind: 'plugin', plugin: 'x' } } })
    expect(model.entries()).toEqual([{ kind: 'notice', text: 'injected x · 1 lines — context' }])
  })

  it('accumulates streamed text and drops it once the durable message settles', () => {
    const model = new TranscriptModel()
    model.applyStreamChunk({ type: 'text-delta', text: 'he' })
    model.applyStreamChunk({ type: 'text-delta', text: 'llo' })
    expect(model.entries()).toEqual([{ kind: 'assistant', text: 'hello' }])
    model.apply({ type: 'assistant/message', data: { message: { content: text('hello') } } })
    expect(model.entries()).toEqual([{ kind: 'assistant', text: 'hello' }])
  })

  it('ignores a streamed block end that is not text', () => {
    const model = new TranscriptModel()
    model.applyStreamChunk({ type: 'text-delta', text: 'kept' })
    model.applyStreamChunk({ type: 'block-end', block: { type: 'tool-call', id: 'x' } })
    expect(model.entries()).toEqual([{ kind: 'assistant', text: 'kept' }])
  })

  it('ignores unrelated events and resets to an empty transcript', () => {
    const model = new TranscriptModel()
    model.apply({ type: 'turn/start', data: { turn: 1 } })
    expect(model.isEmpty()).toBe(true)
    model.notice('local line')
    expect(model.isEmpty()).toBe(false)
    model.reset()
    expect(model.isEmpty()).toBe(true)
  })
})

describe('TranscriptModel reasoning', () => {
  it('shows a live reasoning row and folds it once the message settles', () => {
    const model = new TranscriptModel()
    model.applyStreamChunk({ type: 'reasoning-delta', text: 'think' })
    model.applyStreamChunk({ type: 'reasoning-delta', text: 'ing' })
    expect(model.entries()).toEqual([{ kind: 'reasoning', text: 'reasoning · 8 chars', live: true }])
    model.apply({ type: 'assistant/message', data: { message: { content: text('answer') } } })
    expect(model.entries()).toEqual([
      { kind: 'assistant', text: 'answer' },
      { kind: 'reasoning', text: 'reasoning · 1 lines', live: false },
    ])
  })

  it('folds a completed reasoning block without waiting for the message', () => {
    const model = new TranscriptModel()
    model.applyStreamChunk({ type: 'reasoning-delta', text: 'a\nb' })
    model.applyStreamChunk({ type: 'block-end', block: { type: 'reasoning' } })
    expect(model.entries()).toEqual([{ kind: 'reasoning', text: 'reasoning · 2 lines', live: false }])
  })
})

describe('TranscriptModel tool cards', () => {
  it('asks the presenter for the call and merges the result into the same row', () => {
    const presenter = recordingPresenter()
    const model = new TranscriptModel(presenter)
    model.apply({ type: 'tool/call', data: { name: 'bash', arguments: '{"command":"ls"}', callId: 'c1' } })
    expect(model.entries()).toEqual([{ kind: 'tool', card: card('bash pending', ['from presenter']) }])
    model.apply({
      type: 'tool/result',
      data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', text: 'out' }], isError: false }, meta: { any: 1 } },
    })
    const entries = model.entries()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual({ kind: 'tool', card: card('bash pending', ['result line']) })
    expect(presenter.calls).toEqual(['bash:{"command":"ls"}'])
    expect(presenter.results).toEqual(['bash:{"command":"ls"}:ok'])
  })

  it('marks the row failed when the tool result is an error', () => {
    const presenter = recordingPresenter()
    const model = new TranscriptModel(presenter)
    model.apply({ type: 'tool/call', data: { name: 'bash', arguments: '{}', callId: 'c1' } })
    model.apply({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1' }], isError: true } } })
    const entry = model.entries()[0]
    expect(entry?.kind === 'tool' && entry.card.failed).toBe(true)
  })

  it('appends a standalone row for a result whose call is not in this fold', () => {
    const model = new TranscriptModel()
    model.apply({
      type: 'tool/result',
      data: { message: { content: [{ type: 'tool-result', toolCallId: 'missing', text: 'orphan' }], isError: false } },
    })
    expect(model.entries()).toEqual([
      { kind: 'tool', card: { kind: 'generic', title: 'tool', detail: ['orphan'], failed: false, hiddenLines: 0 } },
    ])
  })

  it('keeps the call row readable when no presenter is mounted', () => {
    const model = new TranscriptModel()
    model.apply({ type: 'tool/call', data: { name: 'grep', arguments: '{"q":"x"}', callId: 'c1' } })
    expect(model.entries()).toEqual([
      { kind: 'tool', card: { kind: 'generic', title: 'grep', detail: ['{"q":"x"}'], failed: false, hiddenLines: 0 } },
    ])
  })
})

describe('TranscriptModel outcomes', () => {
  it('stays quiet when a turn completes normally', () => {
    const model = new TranscriptModel()
    model.apply({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    expect(model.entries()).toEqual([])
  })

  it('reports a failed turn with the provider failure text', () => {
    const model = new TranscriptModel()
    model.apply({
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'error', error: { code: 'MISSING_CREDENTIAL', message: 'no API key' } } },
    })
    expect(model.entries()).toEqual([{ kind: 'notice', text: 'turn failed: no API key' }])
  })

  it('reports an aborted and a blocked turn', () => {
    const model = new TranscriptModel()
    model.apply({ type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
    model.apply({ type: 'turn/end', data: { turn: 2, reason: { kind: 'blocked' } } })
    expect(model.entries()).toEqual([
      { kind: 'notice', text: 'turn aborted (user)' },
      { kind: 'notice', text: 'turn ended: blocked' },
    ])
  })

  it('reports a live agent failure that carries no message', () => {
    const model = new TranscriptModel()
    model.reportError(new Error('connection reset'))
    model.reportError(undefined)
    expect(model.entries()).toEqual([
      { kind: 'notice', text: 'error: connection reset' },
      { kind: 'notice', text: 'error: agent failed' },
    ])
  })

  it('reports an attempt that settled without a message', () => {
    const model = new TranscriptModel()
    model.apply({ type: 'assistant/attempt', data: { turn: 1, step: 1, stream: [], error: { code: 'RATE_LIMIT', message: 'slow down' } } })
    expect(model.entries()).toEqual([{ kind: 'notice', text: 'request failed: slow down' }])
  })

  it('summarizes injected context instead of printing it', () => {
    const model = new TranscriptModel()
    model.apply({
      type: 'user/message',
      data: {
        content: [{ type: 'text', text: '<system-reminder>\nrule one\nrule two' }],
        source: { kind: 'plugin', plugin: 'dsh-agent-instructions' },
      },
    })
    expect(model.entries()).toEqual([
      { kind: 'notice', text: 'injected dsh-agent-instructions · 3 lines — <system-reminder>' },
    ])
  })

  it('truncates a long preview line', () => {
    const model = new TranscriptModel()
    model.apply({
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'x'.repeat(200) }], source: { kind: 'plugin', plugin: 'p' } },
    })
    const entry = model.entries()[0]
    const text = entry !== undefined && entry.kind === 'notice' ? entry.text : ''
    expect(text.startsWith('injected p · 1 lines — ')).toBe(true)
    expect(text.endsWith('…')).toBe(true)
    expect(text.length).toBeLessThan(120)
  })
})
