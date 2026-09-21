import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision } from '@deepseek-ai/dsh-tools'
import {
  TODO_GUARD_DEFAULTS,
  TodoGuard,
  apply,
  foldReminder,
  inject,
  missingListReminder,
  resolveTodoGuardConfig,
  staleReminder,
  type OpenTodo,
  type TodoGuardConfig,
} from '@/todo-guard.ts'
import type { TodoEntry } from '@/work.ts'

const config = (overrides: Partial<TodoGuardConfig> = {}): TodoGuardConfig =>
  resolveTodoGuardConfig(overrides)

const open = (content: string, status: 'pending' | 'in_progress' = 'pending'): OpenTodo => ({ content, status })

const completed = (content: string): TodoEntry => ({ content, status: 'completed' })

/** One session advanced to the given step count, the shape the counters expect. */
function advanced(guard: TodoGuard, steps: number): object {
  const session = {}
  guard.onEvent(session, 'turn/start')
  for (let step = 0; step < steps; step += 1) guard.onEvent(session, 'step/start')
  return session
}

const observation = (todos: readonly TodoEntry[] | undefined) => ({
  toolName: 'edit',
  hasTodoTool: true,
  planActive: false,
  todos,
})

describe('module contract', () => {
  it('injects the tool registry it reads through ctx.tools', () => {
    // Without this inject, `ctx.tools` throws and the guard silently never fires.
    expect(inject).toContain('tools')
  })
})

describe('resolveTodoGuardConfig', () => {
  it('fills the shipped defaults', () => {
    expect(resolveTodoGuardConfig()).toEqual({ ...TODO_GUARD_DEFAULTS })
  })

  it('fails loud on a value that would guard nothing', () => {
    expect(() => resolveTodoGuardConfig({ staleSteps: 0 })).toThrow(/staleSteps/)
    expect(() => resolveTodoGuardConfig({ previewItems: 1.5 })).toThrow(/previewItems/)
    expect(() => resolveTodoGuardConfig({ maxRemindersPerTurn: -1 })).toThrow(/maxRemindersPerTurn/)
  })
})

describe('TodoGuard', () => {
  it('stays silent until a list ages past the threshold', () => {
    const guard = new TodoGuard(config({ staleSteps: 3 }))
    const session = advanced(guard, 2)
    expect(guard.observe(session, observation([open('one')]))).toBeUndefined()
  })

  it('quotes the open items and the step count once stale', () => {
    const guard = new TodoGuard(config({ staleSteps: 3 }))
    const reminder = guard.observe(advanced(guard, 3), observation([
      completed('done bit'),
      open('current bit', 'in_progress'),
    ]))
    expect(reminder?.text).toContain('current bit')
    expect(reminder?.text).not.toContain('done bit')
    expect(reminder?.text).toContain('3 steps')
    expect(reminder?.summary).toBe('todos stale · 3 steps')
  })

  it('reminds at most once per step, however many calls run in it', () => {
    const guard = new TodoGuard(config({ staleSteps: 1, maxRemindersPerTurn: 5 }))
    const session = advanced(guard, 1)
    expect(guard.observe(session, observation([open('one')]))).toBeDefined()
    expect(guard.observe(session, observation([open('one')]))).toBeUndefined()
    guard.onEvent(session, 'step/start')
    expect(guard.observe(session, observation([open('one')]))).toBeDefined()
  })

  it('caps reminders per turn and restores the budget on the next turn', () => {
    const guard = new TodoGuard(config({ staleSteps: 1, maxRemindersPerTurn: 2 }))
    const session = advanced(guard, 1)
    expect(guard.observe(session, observation([open('one')]))).toBeDefined()
    guard.onEvent(session, 'step/start')
    expect(guard.observe(session, observation([open('one')]))).toBeDefined()
    guard.onEvent(session, 'step/start')
    expect(guard.observe(session, observation([open('one')]))).toBeUndefined()
    guard.onEvent(session, 'turn/start')
    guard.onEvent(session, 'step/start')
    expect(guard.observe(session, observation([open('one')]))).toBeDefined()
  })

  it('treats a todo_write as the agent answering and restarts the count', () => {
    const guard = new TodoGuard(config({ staleSteps: 1 }))
    const session = advanced(guard, 5)
    expect(guard.observe(session, { ...observation([open('one')]), toolName: 'todo_write' })).toBeUndefined()
    expect(guard.observe(session, observation([open('one')]))).toBeUndefined()
  })

  it('stays silent in plan mode and without the todo tool', () => {
    const guard = new TodoGuard(config({ staleSteps: 1 }))
    const plan = advanced(guard, 3)
    expect(guard.observe(plan, { ...observation([open('one')]), planActive: true })).toBeUndefined()
    const bare = advanced(guard, 3)
    expect(guard.observe(bare, { ...observation([open('one')]), hasTodoTool: false })).toBeUndefined()
  })

  it('suggests a first list only after a turn runs long, and never over an empty write', () => {
    const guard = new TodoGuard(config({ missingListSteps: 2 }))
    const missing = advanced(guard, 2)
    expect(guard.observe(missing, observation(undefined))?.summary).toBe('todos missing · 2 steps')
    const cleared = advanced(guard, 2)
    expect(guard.observe(cleared, observation([]))).toBeUndefined()
  })

  it('quotes at most previewItems and counts the rest', () => {
    const reminder = staleReminder([open('one'), open('two'), open('three')], 6, 2)
    expect(reminder.text).toContain('one')
    expect(reminder.text).toContain('two')
    expect(reminder.text).not.toContain('three')
    expect(reminder.text).toContain('… 1 more')
  })

  it('has a distinct missing-list reminder', () => {
    expect(missingListReminder(12).text).toContain('12 steps')
    expect(missingListReminder(12).summary).toBe('todos missing · 12 steps')
  })
})

describe('foldReminder', () => {
  const reminder = createUserMessage({
    content: [{ type: 'text', text: 'refresh the list' }],
    source: { kind: 'plugin', plugin: 'tui-todo-guard' },
  })

  it('prepends to an accepted result and keeps downstream context', () => {
    const other = createUserMessage({
      content: [{ type: 'text', text: 'other' }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    const folded = foldReminder(reminder, { kind: 'accept', additionalContexts: [other] })
    expect(folded.kind).toBe('accept')
    if (folded.kind === 'accept') expect(folded.additionalContexts).toEqual([reminder, other])
  })

  it('carries the reminder on a blocked result too', () => {
    const feedback = [{ type: 'text' as const, text: 'denied' }]
    const folded = foldReminder(reminder, { kind: 'block', feedback })
    expect(folded.kind).toBe('block')
    if (folded.kind === 'block') {
      expect(folded.feedback).toEqual(feedback)
      expect(folded.additionalContexts?.[0]).toBe(reminder)
    }
  })
})

describe('apply', () => {
  /** The two host surfaces the guard reads, wired the way Cordis wires them. */
  function fakeContext(state: { todos?: unknown; plan?: unknown }) {
    const handlers = new Map<string, ((...args: unknown[]) => unknown)[]>()
    const ctx = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        const list = handlers.get(name) ?? []
        list.push(handler)
        handlers.set(name, list)
        return () => {}
      },
      tools: { get: (name: string) => name === 'todo_write' ? {} : undefined },
      get(name: string) {
        if (name !== 'sessionProjections') return undefined
        return { stateOf: (_session: unknown, key: string) => key === 'todos' ? state.todos : state.plan }
      },
    }
    return { ctx, handlers }
  }

  it('reminds through the post-execute decision when a projected list is stale', async () => {
    const { ctx, handlers } = fakeContext({
      todos: [open('stale')],
      plan: { active: false },
    })
    apply(ctx as unknown as Context, { staleSteps: 1, missingListSteps: 9, maxRemindersPerTurn: 2, previewItems: 5 })
    const session = {}
    handlers.get('session/event')?.[0]?.(session, { type: 'step/start' })
    const decision = await handlers.get('tools/post-execute')?.[0]?.(
      { name: 'edit', agent: { session } },
      {},
      async () => ({ kind: 'accept' }),
    )
    const contexts = (decision as { additionalContexts?: unknown[] }).additionalContexts ?? []
    expect(contexts).toHaveLength(1)
  })

  it('leaves the decision untouched when nothing is stale', async () => {
    const { ctx, handlers } = fakeContext({ todos: [], plan: { active: false } })
    apply(ctx as unknown as Context, { staleSteps: 1 })
    const session = {}
    handlers.get('session/event')?.[0]?.(session, { type: 'step/start' })
    const decision = await handlers.get('tools/post-execute')?.[0]?.(
      { name: 'edit', agent: { session } },
      {},
      async () => ({ kind: 'accept' }),
    )
    expect((decision as PostToolDecision).additionalContexts).toBeUndefined()
  })
})
