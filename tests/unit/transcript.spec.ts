import { describe, expect, it } from 'vitest'
import { type ToolCard, type ToolPresenter } from '@/cards.ts'
import { REASONING_CHAR_LIMIT, TranscriptModel } from '@/transcript.ts'

const text = (value: string) => [{ type: 'text', text: value }]

const reasoning = (value: string) => ({ type: 'reasoning', text: value })

/** One durable assistant message, in the shape the session log records. */
const message = (content: unknown[]) => ({ type: 'assistant/message', data: { message: { content } } })

const card = (title: string, detail: string[] = []): ToolCard =>
  ({ kind: 'generic', title, detail, failed: false, totalLines: detail.length })

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
  it('shows a live reasoning row, with how long it has been thinking, and settles it ahead of the answer', () => {
    let clock = 1_000
    const model = new TranscriptModel(undefined, () => clock)
    model.applyStreamChunk({ type: 'reasoning-delta', text: 'think' })
    model.applyStreamChunk({ type: 'reasoning-delta', text: 'ing' })
    clock = 4_000
    expect(model.entries()).toEqual([
      { kind: 'reasoning', summary: 'reasoning · 8 chars · 3s · streaming', body: 'thinking', live: true },
    ])
    model.apply({ type: 'assistant/message', data: { message: { content: text('answer') } } })
    expect(model.entries()).toEqual([
      { kind: 'reasoning', summary: 'reasoning · 1 line · 8 chars · 3s', body: 'thinking', live: false },
      { kind: 'assistant', text: 'answer' },
    ])
  })

  it('settles a completed reasoning block without waiting for the message', () => {
    let clock = 0
    const model = new TranscriptModel(undefined, () => clock)
    model.applyStreamChunk({ type: 'reasoning-delta', text: 'a\nb' })
    clock = 2_000
    model.applyStreamChunk({ type: 'block-end', block: { type: 'reasoning' } })
    expect(model.entries()).toEqual([
      { kind: 'reasoning', summary: 'reasoning · 2 lines · 3 chars · 2s', body: 'a\nb', live: false },
    ])
  })

  it('keeps only the head of a runaway thought', () => {
    const model = new TranscriptModel()
    model.applyStreamChunk({ type: 'reasoning-delta', text: 'x'.repeat(REASONING_CHAR_LIMIT + 10) })
    model.applyStreamChunk({ type: 'block-end', block: { type: 'reasoning' } })
    const entry = model.entries()[0]
    expect(entry?.kind).toBe('reasoning')
    const body = entry?.kind === 'reasoning' ? entry.body : ''
    expect(body.startsWith('x'.repeat(64))).toBe(true)
    expect(body.endsWith(`… truncated at ${REASONING_CHAR_LIMIT} chars`)).toBe(true)
  })

  it('keeps a recorded thought out of the answer it precedes', () => {
    // The durable record carries the thinking as a block of its own. Reading
    // every block for text folded it into the reply, so a resumed session
    // showed the model's private reasoning as something it had said.
    const model = new TranscriptModel()
    model.apply(message([reasoning('let me check the registry'), ...text('0.1.2 is published')]))
    expect(model.entries()).toEqual([
      { kind: 'reasoning', summary: 'reasoning · 1 line · 25 chars', body: 'let me check the registry', live: false },
      { kind: 'assistant', text: '0.1.2 is published' },
    ])
  })

  it('renders a recorded thought that never streamed, which is every resumed session', () => {
    const model = new TranscriptModel()
    model.apply(message([reasoning('weighing the options\npicking the second')]))
    expect(model.entries()).toEqual([
      {
        kind: 'reasoning',
        summary: 'reasoning · 2 lines · 39 chars',
        body: 'weighing the options\npicking the second',
        live: false,
      },
    ])
  })

  it('paints a thought once when the stream and the record both carry it', () => {
    const model = new TranscriptModel(undefined, () => 2_000)
    model.applyStreamChunk({ type: 'reasoning-delta', text: 'thinking hard' })
    model.apply(message([reasoning('thinking hard'), ...text('the answer')]))
    expect(model.entries()).toEqual([
      { kind: 'reasoning', summary: 'reasoning · 1 line · 13 chars · 1s', body: 'thinking hard', live: false },
      { kind: 'assistant', text: 'the answer' },
    ])
  })

  it('still reads the text a tool result carries directly', () => {
    // A tool-result block holds its text on the block itself rather than under
    // a nested text block, which is why the reasoning exclusion cannot be an
    // allow-list of text-bearing types.
    const model = new TranscriptModel()
    model.apply({
      type: 'tool/result',
      data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', text: 'file-a\nfile-b' }], isError: false } },
    })
    const entry = model.entries()[0]
    expect(entry?.kind === 'tool' && entry.card.detail).toEqual(['file-a', 'file-b'])
  })

  it('keeps each step of a multi-step turn in the order it was thought', () => {
    const model = new TranscriptModel()
    model.apply({ type: 'tool/call', data: { name: 'bash', arguments: '{}', callId: 'c1' } })
    model.apply(message([reasoning('first thought'), { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }]))
    model.apply(message([reasoning('second thought'), ...text('done')]))
    expect(model.entries().map(entry => entry.kind)).toEqual(['tool', 'reasoning', 'reasoning', 'assistant'])
  })

  it('settles a thought the stream ended before its message arrives', () => {
    // The real ordering: the stream closes the block first, then the durable
    // message carries the same text. Painting both would double the thought.
    const model = new TranscriptModel(undefined, () => 1_000)
    model.applyStreamChunk({ type: 'reasoning-delta', text: 'thinking hard' })
    model.applyStreamChunk({ type: 'block-end', block: { type: 'reasoning' } })
    model.apply(message([reasoning('thinking hard'), ...text('the answer')]))
    expect(model.entries().map(entry => entry.kind)).toEqual(['reasoning', 'assistant'])
  })

  it('keeps two recorded steps apart even when they read the same', () => {
    const model = new TranscriptModel()
    model.apply(message([reasoning('same words'), ...text('one')]))
    model.apply(message([reasoning('same words'), ...text('two')]))
    expect(model.entries().filter(entry => entry.kind === 'reasoning')).toHaveLength(2)
  })
})

describe('TranscriptModel markers', () => {
  it('marks where older history was compacted away', () => {
    const model = new TranscriptModel()
    model.apply({ type: 'compaction/start', data: { compactionId: 'c1', turn: 1 } })
    model.apply({
      type: 'compaction/summary',
      data: { compactionId: 'c1', shadowedSeqs: [1, 2, 3], shadowedTokenCount: 4200 },
    })
    expect(model.entries()).toEqual([
      { kind: 'marker', text: 'compacting the conversation' },
      { kind: 'marker', text: 'compacted 3 events (≈4200 tokens)' },
    ])
  })

  it('carries a marker that a caller sets for work running elsewhere', () => {
    const model = new TranscriptModel()
    model.marker('subagent explorer started')
    expect(model.entries()).toEqual([{ kind: 'marker', text: 'subagent explorer started' }])
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
      { kind: 'tool', card: { kind: 'generic', title: 'tool', detail: ['orphan'], failed: false, totalLines: 1 } },
    ])
  })

  it('keeps the call row readable when no presenter is mounted', () => {
    const model = new TranscriptModel()
    model.apply({ type: 'tool/call', data: { name: 'grep', arguments: '{"q":"x"}', callId: 'c1' } })
    expect(model.entries()).toEqual([
      { kind: 'tool', card: { kind: 'generic', title: 'grep', detail: ['{"q":"x"}'], failed: false, totalLines: 1 } },
    ])
  })

  it('shows every line of a multi-line call that no presenter described', () => {
    const model = new TranscriptModel()
    model.apply({ type: 'tool/call', data: { name: 'bash', arguments: '{"command":"a\nb"}', callId: 'c1' } })
    const entry = model.entries()[0]
    expect(entry?.kind === 'tool' && entry.card.detail).toEqual(['{"command":"a', 'b"}'])
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
    const notice = entry !== undefined && entry.kind === 'notice' ? entry.text : ''
    expect(notice.startsWith('injected p · 1 lines — ')).toBe(true)
    expect(notice.endsWith('…')).toBe(true)
    expect(notice.length).toBeLessThan(120)
  })
})
