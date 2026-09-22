import { describe, expect, it } from 'vitest'
import { cardOfCall, cardOfResult, contentLines, rowText, SUBCALL_MAX, type ToolCard, type ToolPresenter } from '@/cards.ts'
import { REASONING_CHAR_LIMIT, TranscriptModel } from '@/transcript.ts'

const text = (value: string) => [{ type: 'text', text: value }]

const card = (title: string, detail: string[] = [], tool = title): ToolCard =>
  ({ kind: 'generic', tool, title, detail: detail.map(text => ({ parts: [{ class: 'detail' as const, text }] })), failed: false, totalLines: detail.length })

/** Presenter that records what it was asked, so pairing can be asserted. */
function recordingPresenter(): ToolPresenter & { readonly calls: string[]; readonly results: string[] } {
  const calls: string[] = []
  const results: string[] = []
  return {
    calls,
    results,
    call(name, argumentsJson) {
      calls.push(`${name}:${argumentsJson}`)
      return card(`${name} pending`, ['from presenter'], name)
    },
    result(name, input) {
      results.push(`${name}:${input.argumentsJson}:${input.isError ? 'error' : 'ok'}`)
      return card(`${name} settled`, ['result line'], name)
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

  it('keeps streamed text visible when its block ends before the recorded message', () => {
    const model = new TranscriptModel()
    model.applyStreamChunk({ type: 'text-delta', text: 'partial answer' })
    model.applyStreamChunk({ type: 'block-end', block: { type: 'text' } })
    // The message that makes it durable has not arrived, so the text stays up
    // instead of flickering to nothing on the next repaint.
    expect(model.entries()).toEqual([{ kind: 'assistant', text: 'partial answer' }])
  })

  it('drops streamed text a turn ends without recording', () => {
    const model = new TranscriptModel()
    model.applyStreamChunk({ type: 'text-delta', text: 'partial' })
    model.apply({ type: 'turn/end', data: { reason: { kind: 'aborted' } } })
    expect(model.entries().some(entry => entry.kind === 'assistant')).toBe(false)
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
      { kind: 'reasoning', id: '1', summary: 'reasoning · 2 tokens · 3s · streaming', body: 'thinking', live: true },
    ])
    model.apply({ type: 'assistant/message', data: { message: { content: text('answer') } } })
    // The settled row keeps the live row's id, so a click made while the model
    // was still thinking stays on the thought it was made on.
    expect(model.entries()).toEqual([
      { kind: 'reasoning', id: '1', summary: 'reasoning · 2 tokens · 3s', body: 'thinking', live: false },
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
      { kind: 'reasoning', id: '1', summary: 'reasoning · 1 token · 2s', body: 'a\nb', live: false },
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

  it('paints a recorded thought as its own row and keeps it out of the answer', () => {
    const model = new TranscriptModel()
    model.apply({
      type: 'assistant/message',
      data: {
        message: {
          content: [
            { type: 'reasoning', text: 'weigh the options' },
            { type: 'text', text: 'the answer' },
          ],
        },
      },
    })
    expect(model.entries()).toEqual([
      { kind: 'reasoning', id: '1', summary: 'reasoning · 5 tokens', body: 'weigh the options', live: false },
      { kind: 'assistant', text: 'the answer' },
    ])
  })

  it('reports a thought in tokens, rounding a fraction up', () => {
    const model = new TranscriptModel()
    // Five characters is 1.25 tokens at four per token; a reader is billed for two.
    model.apply({ type: 'assistant/message', data: {
      message: { content: [{ type: 'reasoning', text: 'abcde' }, { type: 'text', text: 'a' }] },
    } })
    expect(model.entries()[0]).toMatchObject({ summary: 'reasoning · 2 tokens' })
  })

  it('does not paint the recorded copy of a thought the stream already settled', () => {
    let clock = 0
    const model = new TranscriptModel(undefined, () => clock)
    model.applyStreamChunk({ type: 'reasoning-delta', text: 'a\nb' })
    clock = 2_000
    model.applyStreamChunk({ type: 'block-end', block: { type: 'reasoning' } })
    model.apply({
      type: 'assistant/message',
      data: {
        message: {
          content: [
            { type: 'reasoning', text: 'a\nb' },
            { type: 'text', text: 'the answer' },
          ],
        },
      },
    })
    expect(model.entries()).toEqual([
      { kind: 'reasoning', id: '1', summary: 'reasoning · 1 token · 2s', body: 'a\nb', live: false },
      { kind: 'assistant', text: 'the answer' },
    ])
  })

  it('gives each thought its own id and never reuses one after a reset', () => {
    const model = new TranscriptModel()
    const message = (...thoughts: string[]) => ({
      type: 'assistant/message',
      data: { message: { content: [...thoughts.map(text => ({ type: 'reasoning', text })), { type: 'text', text: 'answer' }] } },
    })
    model.apply(message('one', 'two'))
    const ids = model.entries().flatMap(entry => (entry.kind === 'reasoning' ? [entry.id] : []))
    expect(ids).toEqual(['1', '2'])
    // A session switch clears the rows, not the id space: reusing an id would
    // hand a click the reader made in the old session to the new session's row.
    model.reset()
    model.apply(message('three'))
    expect(model.entries()[0]).toMatchObject({ kind: 'reasoning', id: '3' })
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
    expect(model.entries()).toEqual([{ kind: 'tool', id: 'c1', card: card('bash pending', ['from presenter'], 'bash') }])
    model.apply({
      type: 'tool/result',
      data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', text: 'out' }], isError: false }, meta: { any: 1 } },
    })
    const entries = model.entries()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual({ kind: 'tool', id: 'c1', card: card('bash pending', ['result line'], 'bash') })
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
      { kind: 'tool', id: 'missing', card: card('tool', ['orphan']) },
    ])
  })

  it('keeps the call row readable when no presenter is mounted', () => {
    const model = new TranscriptModel()
    model.apply({ type: 'tool/call', data: { name: 'grep', arguments: '{"q":"x"}', callId: 'c1' } })
    expect(model.entries()).toEqual([
      { kind: 'tool', id: 'c1', card: card('grep', ['{"q":"x"}']) },
    ])
  })

  it("keeps a shell card's command when no result presenter answers", () => {
    // The command belongs to the call, so a declined result must not drop the
    // one thing a folded shell card always shows.
    const presenter: ToolPresenter = {
      call: () => ({ kind: 'terminal', tool: 'bash', title: 'bash', argument: 'echo hi', detail: [], failed: false, totalLines: 0 }),
      result: () => undefined,
    }
    const model = new TranscriptModel(presenter)
    model.apply({ type: 'tool/call', data: { name: 'bash', arguments: '{}', callId: 'c1' } })
    model.apply({
      type: 'tool/result',
      data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', text: 'hi' }], isError: false } },
    })
    const entry = model.entries()[0]
    expect(entry?.kind === 'tool' && entry.card.argument).toBe('echo hi')
    expect(entry?.kind === 'tool' && entry.card.detail.map(rowText)).toEqual(['hi'])
  })

  it('shows every line of a multi-line call that no presenter described', () => {
    const model = new TranscriptModel()
    model.apply({ type: 'tool/call', data: { name: 'bash', arguments: '{"command":"a\nb"}', callId: 'c1' } })
    const entry = model.entries()[0]
    expect(entry?.kind === 'tool' && entry.card.detail.map(rowText)).toEqual(['{"command":"a', 'b"}'])
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

describe('TranscriptModel nested PTC calls', () => {
  const runCall = { type: 'tool/call', data: { name: 'run_code', arguments: '{"code":"x","description":"search"}', callId: 'root' } }
  const runResult = {
    type: 'tool/result',
    data: { message: { content: [{ type: 'tool-result', toolCallId: 'root', text: 'done' }], isError: false } },
  }
  const start = (subCallId: string, name: string, args: unknown, rootCallId = 'root') => ({
    type: 'tool/ptc-dispatch-start',
    data: { rootCallId, parentCallId: rootCallId, subCallId, name, arguments: args },
  })
  const settle = (subCallId: string, name: string, args: unknown, isError: boolean, content: readonly unknown[] = []) => ({
    type: 'tool/ptc-dispatch',
    data: { rootCallId: 'root', parentCallId: 'root', subCallId, name, arguments: args, isError, content },
  })

  it('draws a nested call on the card that dispatched it, and restates it with its outcome', () => {
    const presenter = recordingPresenter()
    const model = new TranscriptModel(presenter)
    model.apply(runCall)
    model.apply(start('root:ptc:1', 'read', { file_path: 'src/x.ts' }))
    const opened = model.entries()[0]
    expect(opened?.kind === 'tool' && opened.card.subCalls).toEqual([{ id: 'root:ptc:1', title: 'read pending', failed: false }])
    expect(presenter.calls).toEqual(['run_code:{"code":"x","description":"search"}', 'read:{"file_path":"src/x.ts"}'])

    model.apply(settle('root:ptc:1', 'read', { file_path: 'src/x.ts' }, true))
    const failed = model.entries()[0]
    expect(failed?.kind === 'tool' && failed.card.subCalls).toEqual([{ id: 'root:ptc:1', title: 'read pending', failed: true }])

    model.apply(runResult)
    const settled = model.entries()[0]
    expect(settled?.kind === 'tool' && settled.card.subCalls).toEqual([{ id: 'root:ptc:1', title: 'read pending', failed: true }])
  })

  it("keeps a dispatched shell call's output for the row a click opens", () => {
    // The program answers with its own return value, so a call's own stdout has
    // nowhere else to live; only a shell view carries it, because that output is
    // what a reader opens the row to see.
    const presenter: ToolPresenter = {
      call: name => (name === 'bash' ? cardOfCall({ card: 'terminal', title: 'echo hi' }, name) : undefined),
      result: (name, input) => (name === 'bash'
        ? cardOfResult(
            { card: 'terminal', output: contentLines(input.content).join('\n'), exitCode: 0 },
            { name, failed: input.isError, contentLines: contentLines(input.content) },
          )
        : undefined),
    }
    const model = new TranscriptModel(presenter)
    model.apply(runCall)
    model.apply(start('root:ptc:1', 'bash', { command: 'echo hi' }))
    model.apply(settle('root:ptc:1', 'bash', { command: 'echo hi' }, false, text('hi\nthere')))
    const opened = model.entries()[0]
    const output = opened?.kind === 'tool' ? opened.card.subCalls?.[0]?.output : undefined
    expect(output?.kind).toBe('terminal')
    expect(output?.rows.map(row => rowText(row))).toEqual(['hi', 'there'])
    expect(output?.totalLines).toBe(2)

    model.apply(start('root:ptc:2', 'read', { file_path: 'src/x.ts' }))
    model.apply(settle('root:ptc:2', 'read', { file_path: 'src/x.ts' }, false, text('file body')))
    const withRead = model.entries()[0]
    expect(withRead?.kind === 'tool' && withRead.card.subCalls?.[1]?.output).toBeUndefined()
  })

  it('keeps the calls in dispatch order and counts every one', () => {
    const model = new TranscriptModel(recordingPresenter())
    model.apply(runCall)
    model.apply(start('root:ptc:1', 'read', { file_path: 'a.ts' }))
    model.apply(settle('root:ptc:1', 'read', { file_path: 'a.ts' }, false))
    model.apply(start('root:ptc:2', 'bash', { command: 'ls' }))
    const card = model.entries()[0]
    const subCalls = card?.kind === 'tool' ? card.card.subCalls : undefined
    expect(subCalls?.map(call => call.title)).toEqual(['read pending', 'bash pending'])
    expect(card?.kind === 'tool' && card.card.subCallsTotal).toBe(2)
  })

  it('caps retained calls and still reports how many ran', () => {
    const model = new TranscriptModel(recordingPresenter())
    model.apply(runCall)
    for (let index = 1; index <= SUBCALL_MAX + 1; index += 1) {
      model.apply(start(`root:ptc:${index}`, 'read', { file_path: `${index}.ts` }))
    }
    const card = model.entries()[0]
    expect(card?.kind === 'tool' && card.card.subCalls).toHaveLength(SUBCALL_MAX)
    expect(card?.kind === 'tool' && card.card.subCallsTotal).toBe(SUBCALL_MAX + 1)
  })

  it('ignores a dispatch whose root call is not in this fold', () => {
    const model = new TranscriptModel(recordingPresenter())
    model.apply(start('other:ptc:1', 'read', { file_path: 'x.ts' }, 'other'))
    expect(model.entries()).toEqual([])
  })

  it('keeps the nested calls when the result presenter declines', () => {
    const presenter: ToolPresenter = {
      call: name => ({ kind: 'generic', tool: name, title: name, detail: [], failed: false, totalLines: 0 }),
      result: () => undefined,
    }
    const model = new TranscriptModel(presenter)
    model.apply(runCall)
    model.apply(start('root:ptc:1', 'read', { file_path: 'x.ts' }))
    model.apply(runResult)
    const card = model.entries()[0]
    expect(card?.kind === 'tool' && card.card.subCalls).toHaveLength(1)
  })
})
