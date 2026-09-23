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

  it('bounds what a streaming thought holds, keeping the newest text', () => {
    const model = new TranscriptModel()
    const bodyOf = (): string => {
      const entry = model.entries()[0]
      return entry?.kind === 'reasoning' ? entry.body : ''
    }
    model.applyStreamChunk({ type: 'reasoning-delta', text: 'a'.repeat(REASONING_CHAR_LIMIT) })
    model.applyStreamChunk({ type: 'reasoning-delta', text: 'b'.repeat(REASONING_CHAR_LIMIT) })
    // Inside the slack the thought is kept whole, so nothing the reader is
    // following disappears while it is still short.
    expect(bodyOf()).toHaveLength(REASONING_CHAR_LIMIT * 2)
    model.applyStreamChunk({ type: 'reasoning-delta', text: 'c'.repeat(REASONING_CHAR_LIMIT) })
    model.applyStreamChunk({ type: 'reasoning-delta', text: 'newest' })
    const body = bodyOf()
    expect(body.length).toBeLessThanOrEqual(REASONING_CHAR_LIMIT * 2)
    expect(body.startsWith('c')).toBe(true)
    expect(body.endsWith('newest')).toBe(true)
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

  it('paints every recorded thought when a turn replays several messages', () => {
    const model = new TranscriptModel()
    const message = (thought: string, answer: string) => ({
      type: 'assistant/message',
      data: { message: { content: [{ type: 'reasoning', text: thought }, { type: 'text', text: answer }] } },
    })
    // History replay has no streams at all, so each message's thought is news;
    // one message's recorded thought must not swallow the next one's.
    model.apply(message('first', 'one'))
    model.apply(message('second', 'two'))
    model.apply(message('third', 'three'))
    const bodies = model.entries().flatMap(entry => (entry.kind === 'reasoning' ? [entry.body] : []))
    expect(bodies).toEqual(['first', 'second', 'third'])
  })

  it('retires a thought the turn never settled', () => {
    const model = new TranscriptModel()
    model.applyStreamChunk({ type: 'reasoning-delta', text: 'old' })
    model.apply({ type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
    // A thought the turn never settled must not stay live across the gap: the
    // next turn's deltas would read as a continuation of it.
    expect(model.entries()).toEqual([{ kind: 'notice', text: 'turn aborted (user)' }])
    model.applyStreamChunk({ type: 'reasoning-delta', text: 'new' })
    expect(model.entries()).toEqual([
      { kind: 'notice', text: 'turn aborted (user)' },
      { kind: 'reasoning', id: '2', summary: expect.any(String), body: 'new', live: true },
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
    // A pinned clock keeps the seconds the fold records for the run a fact of the
    // test rather than a race against the wall clock.
    const model = new TranscriptModel(presenter, () => 1_000)
    model.apply({ type: 'tool/call', data: { name: 'bash', arguments: '{"command":"ls"}', callId: 'c1' } })
    expect(model.entries()).toEqual([{ kind: 'tool', id: 'c1', card: card('bash pending', ['from presenter'], 'bash') }])
    model.apply({
      type: 'tool/result',
      data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', text: 'out' }], isError: false }, meta: { any: 1 } },
    })
    const entries = model.entries()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual({ kind: 'tool', id: 'c1', card: { ...card('bash pending', ['result line'], 'bash'), elapsed: 0 } })
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

  it('names the instruction files an injected workspace context touched', () => {
    const model = new TranscriptModel()
    model.apply({
      type: 'user/message',
      data: {
        content: [{ type: 'text', text: '<system-reminder>\nInstructions from: AGENTS.md\nrule\n</system-reminder>' }],
        source: {
          kind: 'agent-instructions',
          form: 'instructions',
          baseline: true,
          changes: [{ action: 'set', scope: '.\u0000AGENTS.md', path: 'AGENTS.md' }],
        },
      },
    })
    expect(model.entries()).toEqual([{ kind: 'notice', text: 'injected instructions · AGENTS.md · 4 lines' }])
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

  /** The calls the one card in the fold kept, which is what a click opens. */
  const subCallsOf = (model: TranscriptModel) => {
    const entry = model.entries()[0]
    return entry?.kind === 'tool' ? entry.card.subCalls ?? [] : []
  }

  /** What a row says about the call it stands for, apart from the rows it opens to. */
  const rowShape = (model: TranscriptModel) =>
    subCallsOf(model).map(call => `${call.id} ${call.title} ${call.failed}`)

  it('draws a nested call on the card that dispatched it, and restates it with its outcome', () => {
    const presenter = recordingPresenter()
    const model = new TranscriptModel(presenter)
    model.apply(runCall)
    model.apply(start('root:ptc:1', 'read', { file_path: 'src/x.ts' }))
    expect(rowShape(model)).toEqual(['root:ptc:1 read pending false'])
    expect(presenter.calls).toEqual(['run_code:{"code":"x","description":"search"}', 'read:{"file_path":"src/x.ts"}'])

    model.apply(settle('root:ptc:1', 'read', { file_path: 'src/x.ts' }, true))
    expect(rowShape(model)).toEqual(['root:ptc:1 read pending true'])

    model.apply(runResult)
    expect(rowShape(model)).toEqual(['root:ptc:1 read pending true'])
  })

  it('accepts a replayed dispatch after the fold was reset', () => {
    const model = new TranscriptModel(recordingPresenter())
    model.apply(runCall)
    model.apply(start('root:ptc:1', 'read', { file_path: 'src/x.ts' }))
    model.reset()
    // A session switch replays the same ids through the same fold; the remembered
    // child index belongs to the fold that was dropped, not to this one.
    model.apply(runCall)
    model.apply(start('root:ptc:1', 'read', { file_path: 'src/x.ts' }))
    const replayed = model.entries()[0]
    expect(replayed?.kind === 'tool' && replayed.card.subCalls).toHaveLength(1)
  })

  it('forgets a call it did not keep when the run that dispatched it settles', () => {
    const model = new TranscriptModel(recordingPresenter())
    model.apply({ type: 'tool/call', data: { name: 'run_code', arguments: '{}', callId: 'a' } })
    for (let at = 0; at < SUBCALL_MAX; at++) model.apply(start(`a:${at}`, 'read', { file_path: 'f' }, 'a'))
    model.apply(start('a:overflow', 'read', { file_path: 'f' }, 'a'))
    model.apply({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'a', text: 'done' }], isError: false } } })
    // An overflow row has no row to clean up after, so its bookkeeping has to be
    // retired with the run; kept, it would refuse the same id to the next run.
    model.apply({ type: 'tool/call', data: { name: 'run_code', arguments: '{}', callId: 'b' } })
    model.apply(start('a:overflow', 'read', { file_path: 'f' }, 'b'))
    const second = model.entries()[1]
    expect(second?.kind === 'tool' && second.card.subCalls).toHaveLength(1)
  })

  it("keeps a dispatched shell call's output for the row a click opens", () => {
    // The program answers with its own return value, so a call's own stdout has
    // nowhere else to live; a shell view re-presents it from the logged content,
    // which is what a reader opens the row to see.
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
    // A tool whose own view needs metadata a dispatch does not carry still keeps
    // the content the program was shown, so its row opens to an outcome too.
    const fallback = subCallsOf(model)[1]?.output
    expect(fallback?.kind).toBe('generic')
    expect(fallback?.rows.map(rowText)).toEqual(['file body'])
  })

  it('keeps the change a dispatched edit declared, so the row opens to its diff', () => {
    // The call view is the only place an edit's diff exists: the dispatch carries
    // no diff metadata, and a reader clicking the row is asking for the change.
    const presenter: ToolPresenter = {
      call: (name, argumentsJson) => {
        const args = JSON.parse(argumentsJson) as { file_path?: string; old_string?: string; new_string?: string }
        return name === 'edit'
          ? cardOfCall({ card: 'diff', title: 'Edit', diffs: [{ path: args.file_path ?? '', oldText: args.old_string ?? '', newText: args.new_string ?? '' }] }, name)
          : undefined
      },
      result: () => undefined,
    }
    const model = new TranscriptModel(presenter)
    const args = { file_path: 'src/x.ts', old_string: 'b', new_string: 'B' }
    model.apply(runCall)
    model.apply(start('root:ptc:1', 'edit', args))
    // The diff is known the moment the call starts, so the row opens while in flight.
    expect(subCallsOf(model)[0]?.presented?.rows.map(rowText)).toEqual(['src/x.ts  -1 +1', '-b', '+B'])
    expect(subCallsOf(model)[0]?.output).toBeUndefined()

    model.apply(settle('root:ptc:1', 'edit', args, false, text('The file src/x.ts has been updated successfully.')))
    const call = subCallsOf(model)[0]
    expect(call?.presented?.kind).toBe('diff')
    expect(call?.presented?.rows.map(rowText)).toEqual(['src/x.ts  -1 +1', '-b', '+B'])
    expect(call?.output?.rows.map(rowText)).toEqual(['The file src/x.ts has been updated successfully.'])
  })

  it('takes back the change a failed call declared and keeps the reason it failed', () => {
    const presenter: ToolPresenter = {
      call: () => cardOfCall({ card: 'diff', title: 'Edit', diffs: [{ path: 'src/x.ts', oldText: 'b', newText: 'B' }] }, 'edit'),
      result: () => undefined,
    }
    const model = new TranscriptModel(presenter)
    const reason = 'Error: cannot modify "src/x.ts": file has not been read — read the file, then retry'
    model.apply(runCall)
    model.apply(start('root:ptc:1', 'edit', { file_path: 'src/x.ts' }))
    model.apply(settle('root:ptc:1', 'edit', { file_path: 'src/x.ts' }, true, text(reason)))
    const call = subCallsOf(model)[0]
    expect(call?.failed).toBe(true)
    // Rows that still drew as applied would claim a change that never happened.
    expect(call?.presented).toBeUndefined()
    expect(call?.output?.rows.map(rowText)).toEqual([reason])
  })

  it('opens a row for a tool the surface has no presenter for', () => {
    const model = new TranscriptModel()
    model.apply(runCall)
    model.apply(start('root:ptc:1', 'mystery', { a: 1 }))
    model.apply(settle('root:ptc:1', 'mystery', { a: 1 }, false, text('mystery said no')))
    const call = subCallsOf(model)[0]
    expect(call?.title).toBe('mystery')
    expect(call?.presented).toBeUndefined()
    expect(call?.output?.rows.map(rowText)).toEqual(['mystery said no'])
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

  it('marks a dispatched call in flight only until its dispatch log lands', () => {
    const model = new TranscriptModel(recordingPresenter())
    model.apply(runCall)
    model.apply(start('root:ptc:1', 'read', { file_path: 'src/x.ts' }))
    // The start is logged before the call runs, so the row drawn from it is the
    // only sign a reader has that the program is waiting on this call.
    expect(subCallsOf(model).map(call => call.running)).toEqual([true])

    model.apply(settle('root:ptc:1', 'read', { file_path: 'src/x.ts' }, false))
    expect(subCallsOf(model).map(call => call.running)).toEqual([false])
  })

  it('ends a dispatched call that answered with nothing to open', () => {
    // A call whose content the program discarded still settles: a row left
    // saying it is running would outlive the program that dispatched it.
    const presenter: ToolPresenter = { call: () => undefined, result: () => undefined }
    const model = new TranscriptModel(presenter)
    model.apply(runCall)
    model.apply(start('root:ptc:1', 'read', { file_path: 'src/x.ts' }))
    model.apply(settle('root:ptc:1', 'read', { file_path: 'src/x.ts' }, false))
    expect(subCallsOf(model).map(call => call.running)).toEqual([false])
    expect(subCallsOf(model)[0]?.output).toBeUndefined()
  })
})

describe('TranscriptModel live calls', () => {
  /** A clock the test moves by hand, so a duration is an assertion and not a race. */
  const clockAt = (start: number) => {
    const state = { now: start }
    return { state, clock: () => state.now }
  }

  const call = { type: 'tool/call', data: { name: 'bash', arguments: '{"command":"sleep 5"}', callId: 'c1' } }
  const result = {
    type: 'tool/result',
    data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', text: 'done' }], isError: false } },
  }

  it('reports a requested call as in flight, from the moment it was requested', () => {
    const { state, clock } = clockAt(1_000)
    const model = new TranscriptModel(undefined, clock)
    model.apply(call)
    expect(model.liveCall('c1')).toEqual({ running: true, elapsed: 0 })

    state.now = 13_000
    expect(model.liveCall('c1')).toEqual({ running: true, elapsed: 12 })
  })

  it('stops reporting a call once its result lands', () => {
    const { state, clock } = clockAt(1_000)
    const model = new TranscriptModel(undefined, clock)
    model.apply(call)
    model.apply(result)
    state.now = 60_000
    expect(model.liveCall('c1')).toEqual({ running: false, elapsed: 0 })
  })

  it('reports nothing for an id this fold never saw, as a resumed row must', () => {
    const model = new TranscriptModel()
    expect(model.liveCall('missing')).toEqual({ running: false, elapsed: 0 })
    expect(model.liveCall('')).toEqual({ running: false, elapsed: 0 })
  })

  it('keeps the card it settled from claiming to be in flight', () => {
    const { clock } = clockAt(1_000)
    const model = new TranscriptModel(undefined, clock)
    model.apply(call)
    const [entry] = model.entries()
    // The card drawn from the call is the one a renderer sees before any result;
    // the fold itself never marks it, so a settled row cannot inherit the claim.
    expect(entry?.kind === 'tool' && entry.card.running).toBeUndefined()
    model.apply(result)
    const [settled] = model.entries()
    expect(settled?.kind === 'tool' && settled.card.running).toBeUndefined()
  })
})
