import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ForkEvent } from '@/agent/fork.ts'
import { hiddenTail, NO_UNDO, redoStep, resetUndo, turnsOf, undoStep } from '@/agent/undo.ts'

const prompt = (text: string, seq: number, kind = 'user'): ForkEvent => ({
  type: 'user/message',
  data: { content: [{ type: 'text', text }], source: { kind } },
  seq,
})

/** One closed turn with a direct prompt, positioned after the events given. */
const turn = (n: number, prior: readonly ForkEvent[], text = `ask ${n}`): ForkEvent[] => [
  { type: 'turn/start', data: { turn: n }, seq: prior.length },
  prompt(text, prior.length + 1),
  { type: 'assistant/message', data: {}, seq: prior.length + 2 },
  { type: 'turn/end', data: { turn: n }, seq: prior.length + 3 },
]

describe('turnsOf', () => {
  it('reads nothing from an empty or open log', () => {
    expect(turnsOf([])).toEqual([])
    expect(turnsOf([{ type: 'turn/start', data: { turn: 1 }, seq: 0 }, prompt('open', 1)])).toEqual([])
  })

  it('reads closed turns positionally and records where their prefix ends', () => {
    const events = [...turn(1, []), ...turn(2, turn(1, []))]
    expect(turnsOf(events)).toEqual([
      { turn: 1, seedCount: 0, promptText: 'ask 1' },
      { turn: 2, seedCount: 4, promptText: 'ask 2' },
    ])
  })

  it('ignores injected context and keeps the first human prompt of a multi-prompt turn', () => {
    const events: ForkEvent[] = [
      { type: 'turn/start', data: { turn: 1 }, seq: 0 },
      prompt('injected', 1, 'plugin'),
      prompt('mine', 2),
      prompt('also mine', 3),
      { type: 'turn/end', data: { turn: 1 }, seq: 4 },
    ]
    expect(turnsOf(events)).toEqual([{ turn: 1, seedCount: 0, promptText: 'mine' }])
  })
})

describe('the staged cursor', () => {
  const turns = turnsOf([...turn(1, []), ...turn(2, turn(1, []))])

  it('steps back to the newest prompt, then the one before it, then stops', () => {
    const start = resetUndo(SessionId('s1'))
    const once = undoStep(start, turns)
    expect(once).toEqual({ sessionId: 's1', hidden: 1, lastRestored: 'ask 2' })
    const twice = undoStep(once!, turns)
    expect(twice?.hidden).toBe(2)
    expect(twice?.lastRestored).toBe('ask 1')
    expect(undoStep(twice!, turns)).toBeUndefined()
    expect(hiddenTail(twice!, turns)?.seedCount).toBe(0)
  })

  it('steps forward and clears the composer text at the tip', () => {
    const twice = undoStep(undoStep(resetUndo(SessionId('s1')), turns)!, turns)!
    const back = redoStep(twice, turns)!
    expect(back.lastRestored).toBe('ask 2')
    expect(hiddenTail(back, turns)?.seedCount).toBe(4)
    const tip = redoStep(back, turns)!
    expect(tip).toEqual({ sessionId: 's1', hidden: 0, lastRestored: '' })
    expect(redoStep(tip, turns)).toBeUndefined()
    expect(hiddenTail(tip, turns)).toBeUndefined()
  })

  it('starts at the tip with nothing staged', () => {
    expect(NO_UNDO).toEqual({ sessionId: undefined, hidden: 0, lastRestored: '' })
  })
})
