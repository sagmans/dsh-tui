import { describe, expect, it } from 'vitest'
import { WorkFold, planSelectedActive, planToggleLine, readPlanState, type ServiceLookup } from '@/work.ts'

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

describe('the plan toggle', () => {
  it('asks for the other state, one command each way', () => {
    // /plan only enters: the exit is a different command, so the surface names
    // the state it wants rather than toggling a flag of its own.
    expect(planToggleLine(false)).toBe('/plan')
    expect(planToggleLine(true)).toBe('/plan off')
  })

  it('reads a waiting selection as the state the agent is about to be in', () => {
    // Inside a turn the selection sits pending until the next pre-step; asking
    // for the logged state again is a no-op the reader would read as a dead key.
    expect(planSelectedActive({ active: false, pending: true }, false)).toBe(true)
    expect(planSelectedActive({ active: true, pending: false }, true)).toBe(false)
    expect(planSelectedActive({ active: true }, false)).toBe(true)
    expect(planSelectedActive({ active: false }, true)).toBe(false)
  })

  it('falls back to the fold when the composition has no plan controller', () => {
    expect(planSelectedActive(undefined, true)).toBe(true)
    expect(planSelectedActive(undefined, false)).toBe(false)
  })

  it('asks the composition that owns the agent before the container', () => {
    // A preset mounts the package behind isolate, which the container cannot
    // see: the agent's registry is asked first, and the container is the
    // fallback for a composition that mounts the package flat.
    const presetController = { get: () => ({ active: true, pending: false }) }
    const containerController = { get: () => ({ active: false }) }
    const lookup = (preset: unknown, container: unknown): ServiceLookup => ({
      direct: name => (name === 'planMode' ? container : undefined),
      forAgent: (agent, name) => (name === 'planMode' && agent === 'the-agent' ? preset : undefined),
    })
    expect(readPlanState(lookup(presetController, containerController), 'the-agent')).toEqual({ active: true, pending: false })
    expect(readPlanState(lookup(presetController, undefined), 'the-agent')).toEqual({ active: true, pending: false })
    expect(readPlanState(lookup(undefined, containerController), 'the-agent')).toEqual({ active: false })
    expect(readPlanState(lookup(undefined, undefined), 'the-agent')).toBeUndefined()
    // Another service registered under the name is not a plan controller, and a
    // controller that cannot answer is no answer at all.
    expect(readPlanState(lookup({ set: () => 'committed' }, undefined), 'the-agent')).toBeUndefined()
    expect(readPlanState(lookup({ get: () => undefined }, undefined), 'the-agent')).toBeUndefined()
  })
})
