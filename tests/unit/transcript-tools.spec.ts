/**
 * The root tool row: how a call and its result pair into one card, what a
 * missing presenter leaves readable, and what the fold calls in flight.
 */

import { describe, expect, it } from 'vitest'
import { rowText, type ToolPresenter } from '@/cards.ts'
import { TranscriptModel } from '@/transcript.ts'
import { text, card, recordingPresenter } from './fixtures/transcript.ts'


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
  it('keeps the verdict the result drew, not only the one the log flagged', () => {
      // A shell reports a command that exited non-zero as an ordinary result, so the
      // card the presenter built is the only thing that knows the call failed.
      const presenter = {
        calls: [] as string[],
        results: [] as string[],
        call: () => ({ kind: 'terminal' as const, tool: 'bash', title: 'bash', argument: 'exit 1', detail: [], failed: false, totalLines: 0 }),
        result: () => ({ kind: 'terminal' as const, tool: 'bash', title: 'bash', argument: 'exit 1', status: 'exit 1', detail: [], failed: true, totalLines: 0 }),
      }
      const model = new TranscriptModel(presenter)
      model.apply({ type: 'tool/call', data: { name: 'bash', arguments: '{"command":"exit 1"}', callId: 'c1' } })
      model.apply({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', text: 'boom' }], isError: false } } })
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
