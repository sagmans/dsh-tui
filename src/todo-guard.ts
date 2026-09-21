import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { projectionRead } from './agent/projections.ts'
import type { TodoEntry } from './work.ts'

/**
 * Advisory todo discipline.
 *
 * The model already owns a whole-list todo tool; what it lacks is a reason to
 * keep the list current over a long turn. This guard watches the harness's own
 * projections and, when a plan ages past a threshold, rides the next tool
 * result with a model-visible reminder — the same `additionalContexts` channel
 * the repeat-tool reminder uses. It never vetoes a call and never steers a
 * stopped turn, so it cannot loop; the per-turn cap bounds the one extra step
 * each injected reminder costs the loop.
 */

export const name = 'tui-todo-guard'

/** The tool registry is read through the injected property, so Cordis must provide it first. */
export const inject = ['tools']

/** The tool this guard exists to keep honest, as the registry publishes it. */
export const TODO_WRITE_TOOL = 'todo_write'

/** The durable events the counter follows. */
const TURN_START = 'turn/start'
const STEP_START = 'step/start'
/** The tool's own snapshot event, appended only once a write is committed. */
const TODO_WRITE_EVENT = 'todo/write'

/** Projection keys the harness registers for the tool and for plan mode. */
const TODOS_KEY = 'todos'
const PLAN_KEY = 'plan'

/** The reminder source; unlabeled context would read as a user prompt in derived history. */
const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'tui-todo-guard' }

/** Defaults every deployment inherits; the bundle patch states them again for readers. */
export const TODO_GUARD_DEFAULTS = {
  staleSteps: 6,
  missingListSteps: 12,
  maxRemindersPerTurn: 3,
  previewItems: 5,
} as const

/** The knobs a deployment may tune; the whole object is validated fail-loud. */
export interface TodoGuardConfig {
  /** Model steps a non-empty open list may age before a reminder. */
  readonly staleSteps: number
  /** Steps in a turn before the guard suggests a first list at all. */
  readonly missingListSteps: number
  /** Hard cap on reminders, and so on the extra steps they cost, per turn. */
  readonly maxRemindersPerTurn: number
  /** Open items quoted in a reminder; the rest become a count. */
  readonly previewItems: number
}

/** The loader validates the row against this schema before `apply` sees it. */
export const Config: z<TodoGuardConfig> = z.object({
  staleSteps: z.number().default(TODO_GUARD_DEFAULTS.staleSteps),
  missingListSteps: z.number().default(TODO_GUARD_DEFAULTS.missingListSteps),
  maxRemindersPerTurn: z.number().default(TODO_GUARD_DEFAULTS.maxRemindersPerTurn),
  previewItems: z.number().default(TODO_GUARD_DEFAULTS.previewItems),
})

/** One field that must be a positive whole number, or a load-time failure. */
function positiveInteger(field: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`todo-guard: \`${field}\` must be an integer >= 1 (got ${String(value)})`)
  }
  return value
}

/**
 * Apply defaults and validate. The loader normally fills the defaults, but a
 * direct `apply` call (a test, or a composition that bypasses schemastery)
 * must fail loud rather than silently guard nothing.
 */
export function resolveTodoGuardConfig(config: Partial<TodoGuardConfig> = {}): TodoGuardConfig {
  return {
    staleSteps: positiveInteger('staleSteps', config.staleSteps ?? TODO_GUARD_DEFAULTS.staleSteps),
    missingListSteps: positiveInteger('missingListSteps', config.missingListSteps ?? TODO_GUARD_DEFAULTS.missingListSteps),
    maxRemindersPerTurn: positiveInteger('maxRemindersPerTurn', config.maxRemindersPerTurn ?? TODO_GUARD_DEFAULTS.maxRemindersPerTurn),
    previewItems: positiveInteger('previewItems', config.previewItems ?? TODO_GUARD_DEFAULTS.previewItems),
  }
}

/** A todo still owed to the reader; the dock draws the same two states. */
type OpenTodoStatus = Exclude<TodoEntry['status'], 'completed'>

export type OpenTodo = TodoEntry & { readonly status: OpenTodoStatus }

const OPEN_GLYPHS: Readonly<Record<OpenTodoStatus, string>> = { pending: '☐', in_progress: '▸' }

const isOpenTodo = (todo: TodoEntry): todo is OpenTodo => todo.status !== 'completed'

/** The model-visible text and the source summary that labels it. */
export interface TodoReminder {
  readonly text: string
  readonly summary: string
}

/** The stale-list reminder: the plan aged, so it is now describing earlier work. */
export function staleReminder(open: readonly OpenTodo[], steps: number, previewItems: number): TodoReminder {
  const shown = open.slice(0, previewItems)
  const omitted = open.length - shown.length
  return {
    text: [
      `Your todo list is stale: ${steps} step${steps === 1 ? '' : 's'} have passed without a todo_write, and ${open.length} item${open.length === 1 ? '' : 's'} ${open.length === 1 ? 'is' : 'are'} still open:`,
      ...shown.map(todo => `  ${OPEN_GLYPHS[todo.status]} ${todo.content}`),
      ...(omitted > 0 ? [`  … ${omitted} more`] : []),
      'Update it now: mark finished items completed, mark the item you are working on in_progress, and add work you discovered. Do not leave the list describing earlier work.',
    ].join('\n'),
    summary: `todos stale · ${steps} steps`,
  }
}

/** The reminder for a long turn that has produced no list at all. */
export function missingListReminder(steps: number): TodoReminder {
  return {
    text: `${steps} steps have run in this turn without a todo list. If this work has more than one step, call todo_write now to record the concrete remaining steps and mark the one you are on in_progress.`,
    summary: `todos missing · ${steps} steps`,
  }
}

/** One session's step and reminder budget, bounded by the object's own lifetime. */
interface Counters {
  steps: number
  reminders: number
  remindedThisStep: boolean
}

/**
 * What one read of the `todos` projection found.
 *
 * `absent` is the tool's own "nothing written yet"; `unavailable` is a registry
 * that cannot answer at all. The guard promises silence for the second, so the
 * two must not collapse into one.
 */
export type TodoListRead =
  | { readonly kind: 'listed'; readonly todos: readonly TodoEntry[] }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unavailable' }

/** What the guard reads about one agent before deciding whether to speak. */
export interface TodoObservation {
  readonly toolName: string
  readonly hasTodoTool: boolean
  /** Plan mode suppresses the guard; `undefined` is a plan read that cannot answer. */
  readonly planActive: boolean | undefined
  readonly todos: TodoListRead
}

/**
 * The decision core, free of Cordis so it can be tested directly.
 *
 * It counts model steps rather than tool calls: a plan ages by how much the
 * agent has thought and acted since its last write, and a parallel batch of
 * calls is one step, so one batch can never spend the whole reminder budget.
 */
export class TodoGuard {
  private readonly counters = new WeakMap<object, Counters>()

  constructor(private readonly config: TodoGuardConfig) {}

  /** Follow the durable events that open a turn or a step. */
  onEvent(session: object, type: string): void {
    const counters = this.countersFor(session)
    if (type === TURN_START) {
      counters.steps = 0
      counters.reminders = 0
      counters.remindedThisStep = false
      return
    }
    if (type === STEP_START) {
      counters.steps += 1
      counters.remindedThisStep = false
      return
    }
    // Only a committed write restarts the age. An attempt the tool rejected
    // never reaches this event, so it cannot buy the stale list quiet steps.
    if (type === TODO_WRITE_EVENT) counters.steps = 0
  }

  /** The reminder this tool result should carry, or undefined to stay silent. */
  observe(session: object, observation: TodoObservation): TodoReminder | undefined {
    const counters = this.countersFor(session)
    // Never speak on the write's own result; the committed event restarts the
    // count, so a rejected attempt does not silence the guard either.
    if (observation.toolName === TODO_WRITE_TOOL) return undefined
    if (!observation.hasTodoTool) return undefined
    // Plan mode suppresses the guard, and an unreadable plan projection is not
    // a `false` answer, so only a definite "not in plan mode" lets it speak.
    if (observation.planActive !== false) return undefined
    if (observation.todos.kind === 'unavailable') return undefined
    if (counters.remindedThisStep || counters.reminders >= this.config.maxRemindersPerTurn) return undefined
    const open = observation.todos.kind === 'listed' ? observation.todos.todos.filter(isOpenTodo) : []
    const reminder = open.length > 0
      ? counters.steps >= this.config.staleSteps
        ? staleReminder(open, counters.steps, this.config.previewItems)
        : undefined
      : observation.todos.kind === 'absent' && counters.steps >= this.config.missingListSteps
        ? missingListReminder(counters.steps)
        : undefined
    if (reminder === undefined) return undefined
    counters.steps = 0
    counters.remindedThisStep = true
    counters.reminders += 1
    return reminder
  }

  private countersFor(session: object): Counters {
    let counters = this.counters.get(session)
    if (counters === undefined) {
      counters = { steps: 0, reminders: 0, remindedThisStep: false }
      this.counters.set(session, counters)
    }
    return counters
  }
}

/**
 * Prepend the guard's context while preserving every downstream context's own
 * source, and carry it on a block as well so a denied call still reads it.
 */
export function foldReminder(reminder: UserMessage, downstream: PostToolDecision): PostToolDecision {
  const contexts = [reminder, ...downstream.additionalContexts ?? []]
  if (downstream.kind === 'block') {
    return { kind: 'block', feedback: downstream.feedback, additionalContexts: contexts }
  }
  return { ...downstream, additionalContexts: contexts }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

const TODO_STATUSES: ReadonlySet<string> = new Set(['pending', 'in_progress', 'completed'])

/** The current whole list from the harness projection. */
function readTodos(ctx: Context, session: object): TodoListRead {
  const read = projectionRead(ctx, session, TODOS_KEY)
  // The projection is an array once the tool has written and `null` before
  // that; an unregistered or unreadable unit silences us instead.
  if (read.kind !== 'state') return { kind: 'unavailable' }
  const state = read.state
  if (state === null) return { kind: 'absent' }
  if (!Array.isArray(state)) return { kind: 'unavailable' }
  const todos: TodoEntry[] = []
  for (const item of state) {
    const record = asRecord(item)
    const content = record?.content
    const status = record?.status
    if (typeof content !== 'string') continue
    if (typeof status !== 'string' || !TODO_STATUSES.has(status)) continue
    todos.push({ content, status: status as TodoEntry['status'] })
  }
  return { kind: 'listed', todos }
}

/** Whether this session is in plan mode; `undefined` when that cannot be read. */
function readPlanActive(ctx: Context, session: object): boolean | undefined {
  const read = projectionRead(ctx, session, PLAN_KEY)
  // An unregistered key means plan mode is not composed for this agent, which is
  // a definite "not in plan mode". A registered unit that cannot answer is not a
  // definite anything, so it keeps the guard silent.
  if (read.kind === 'unregistered') return false
  if (read.kind !== 'state') return undefined
  return asRecord(read.state)?.active === true
}

/** Whether `todo_write` is reachable from this agent, so a tool-less preset stays silent. */
function todoToolAvailable(ctx: Context, agent: Agent): boolean {
  try {
    // `get` is presentation-agnostic: under PTC the model sees only `run_code`,
    // but the sub-dispatch it programs still reaches `todo_write`, so a scan of
    // the wire schemas would wrongly silence the guard in the default mode.
    // Read live: a cached answer would outlive a registry that changed.
    return ctx.tools.get(TODO_WRITE_TOOL, agent) !== undefined
  } catch {
    // A torn-down scope answers nothing; the next call asks again rather than
    // remembering a transient failure as a permanent silence.
    return false
  }
}

/**
 * Install the guard's listeners.
 *
 * The list and plan come from the host projections rather than a private fold,
 * so this reads exactly the lifetime every other surface shows. Absent
 * projections mean silence, never an error, because the guard is decoration.
 */
export function apply(ctx: Context, config: Partial<TodoGuardConfig> = {}): void {
  const resolved = resolveTodoGuardConfig(config)
  const guard = new TodoGuard(resolved)

  ctx.on('session/event', (session, event) => { guard.onEvent(session, event.type) })

  ctx.on('tools/post-execute', async (exec: ToolExecution, result: Readonly<ToolExecutionResult>, next): Promise<PostToolDecision> => {
    const agent = exec.agent
    // Observe before delegating so a downstream block cannot hide the fact that
    // the step happened; the reminder then rides whatever decision comes back.
    // A concluding result ends the turn at this step, so a context here would
    // only buy one more step after the tools have already wound down.
    const reminder = agent === undefined || result.concludesTurn === true ? undefined : guard.observe(agent.session, {
      toolName: exec.name,
      hasTodoTool: todoToolAvailable(ctx, agent),
      planActive: readPlanActive(ctx, agent.session),
      todos: readTodos(ctx, agent.session),
    })
    const downstream = await next()
    if (reminder === undefined) return downstream
    return foldReminder(createUserMessage({
      content: [{ type: 'text', text: reminder.text }],
      source: { ...PLUGIN_SOURCE, form: 'notice', summary: reminder.summary },
    }), downstream)
  })
}
