/**
 * What the fold records as reading order: prompts and text, thoughts and how
 * they settle, markers, and the outcomes a turn reports.
 */

import { describe, expect, it } from 'vitest'
import { REASONING_CHAR_LIMIT, TranscriptModel } from '@/transcript.ts'
import { text } from './fixtures/transcript.ts'


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
