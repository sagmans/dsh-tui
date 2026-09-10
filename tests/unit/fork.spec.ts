import { describe, expect, it } from 'vitest'
import { forkPoint, type ForkEvent } from '@/agent/fork.ts'

const turn = (n: number, events: ForkEvent[]): ForkEvent[] => [
  { type: 'turn/start', data: { turn: n }, seq: events.length },
  { type: 'user/message', data: {}, seq: events.length + 1 },
  { type: 'assistant/message', data: {}, seq: events.length + 2 },
  { type: 'turn/end', data: { turn: n, reason: { kind: 'completed' } }, seq: events.length + 3 },
]

describe('forkPoint', () => {
  it('refuses a session with no completed turn', () => {
    expect(forkPoint([])).toBeUndefined()
    expect(forkPoint([{ type: 'turn/start', data: { turn: 1 } }])).toBeUndefined()
  })

  it('branches after the last completed turn', () => {
    const events = turn(1, [])
    const point = forkPoint(events)
    expect(point?.inheritedEvents).toBe(events.length)
    expect(point?.boundarySeq).toBe(3)
  })

  it('leaves an open turn behind', () => {
    const events = [...turn(1, []), { type: 'turn/start', data: { turn: 2 } }, { type: 'user/message', data: {} }]
    expect(forkPoint(events)?.inheritedEvents).toBe(4)
  })

  it('keeps the trailing bookkeeping of the turn it cuts at', () => {
    const events = [...turn(1, []), { type: 'session/title', data: { title: 'x' } }, { type: 'turn/start', data: { turn: 2 } }]
    // The title belongs to the first turn and travels with it.
    expect(forkPoint(events)?.inheritedEvents).toBe(5)
  })

  it('branches at the newest completed turn when later turns are unfinished', () => {
    const events = [...turn(1, []), ...turn(2, []), { type: 'turn/start', data: { turn: 3 } }]
    expect(forkPoint(events)?.inheritedEvents).toBe(8)
  })
})
