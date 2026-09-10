import { describe, expect, it } from 'vitest'
import { WorkFold } from '@/work.ts'

const foldWith = (...events: Array<{ type: string; data?: unknown }>): WorkFold => {
  const fold = new WorkFold()
  for (const event of events) fold.apply(event)
  return fold
}

describe('WorkFold', () => {
  it('says nothing before the agent does anything', () => {
    expect(new WorkFold().state()).toEqual({ planMode: false, todos: undefined, goal: undefined })
  })

  it('follows the last plan-mode decision', () => {
    const fold = foldWith({ type: 'plan/mode', data: { active: true } })
    expect(fold.state().planMode).toBe(true)
    fold.apply({ type: 'plan/mode', data: { active: false } })
    expect(fold.state().planMode).toBe(false)
  })

  it('keeps the latest whole todo list and drops an empty one', () => {
    const fold = foldWith({ type: 'todo/write', data: { todos: [{ content: 'one', status: 'pending' }] } })
    expect(fold.state().todos).toEqual([{ content: 'one', status: 'pending' }])
    fold.apply({ type: 'todo/write', data: { todos: [{ content: 'two', status: 'in_progress' }] } })
    expect(fold.state().todos).toEqual([{ content: 'two', status: 'in_progress' }])
    fold.apply({ type: 'todo/write', data: { todos: [] } })
    expect(fold.state().todos).toBeUndefined()
  })

  it('refuses a todo entry it cannot render', () => {
    const fold = foldWith({
      type: 'todo/write',
      data: { todos: [{ content: 'ok', status: 'pending' }, { content: 'bad', status: 'nope' }, { status: 'pending' }] },
    })
    expect(fold.state().todos).toEqual([{ content: 'ok', status: 'pending' }])
  })

  it('follows a goal and forgets it on the clear tombstone', () => {
    const fold = foldWith({
      type: 'goal/change',
      data: { operation: 'create', roundsStarted: 2, goal: { objective: 'ship it', maxGoalRounds: 256 } },
    })
    expect(fold.state().goal).toEqual({ objective: 'ship it', roundsStarted: 2, maxRounds: 256 })
    fold.apply({ type: 'goal/change', data: { operation: 'clear', cleared: { id: 'g' } } })
    expect(fold.state().goal).toBeUndefined()
  })

  it('resets to a blank state', () => {
    const fold = foldWith({ type: 'plan/mode', data: { active: true } })
    fold.reset()
    expect(fold.state()).toEqual({ planMode: false, todos: undefined, goal: undefined })
  })

  it('ignores events that are not work state', () => {
    const fold = foldWith({ type: 'turn/start', data: { turn: 1 } }, { type: 'todo/write', data: {} })
    expect(fold.state().todos).toBeUndefined()
  })
})
