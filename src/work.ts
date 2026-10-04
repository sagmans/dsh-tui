import type { FoldableEvent } from './transcript.ts'

/** Keep provenance separate from rendering so empty boards do not claim an unwritten history. */
const TODO_STATES = {
  neverWritten: 'never-written',
  written: 'written',
  turnCleared: 'turn-cleared',
} as const
/** A turn boundary is not an explicit empty write; the command must name the actual cause. */
const TODO_EMPTY_DESCRIPTIONS = {
  [TODO_STATES.neverWritten]: 'no todo list has been written in this session',
  [TODO_STATES.written]: 'the todo list is empty',
  [TODO_STATES.turnCleared]: 'the todo list was cleared when this turn started',
} as const

type TodoState = typeof TODO_STATES[keyof typeof TODO_STATES]

/** Share the surface's content/status contract between the durable fold, dock, and guard without importing the agent-owned tool. */
export interface TodoEntry {
  readonly content: string
  readonly status: 'pending' | 'in_progress' | 'completed'
}

/** The goal a continuation loop is driving, when one is set. */
export interface GoalState {
  readonly objective: string
  readonly roundsStarted: number
  readonly maxRounds: number | undefined
  /**
   * The phase the row has to name.
   *
   * Completion never reaches the dock: the harness keeps the completed snapshot
   * as the session's last goal, and a settled item leaves the board instead of
   * turning into a completed row.
   */
  readonly phase: 'active' | 'paused' | 'blocked'
}

/** What the agent is working on, folded from durable events. */
export interface WorkState {
  readonly planMode: boolean
  readonly todos: readonly TodoEntry[] | undefined
  /** Retain why the board is absent so commands cannot mistake a turn boundary for unwritten history. */
  readonly todoState: TodoState
  readonly goal: GoalState | undefined
}

const EMPTY: WorkState = { planMode: false, todos: undefined, todoState: TODO_STATES.neverWritten, goal: undefined }

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

const TODO_STATUSES = new Set<TodoEntry['status']>(['pending', 'in_progress', 'completed'])

/** Recover displayable entries from the current snapshot so one malformed item
 * does not hide valid siblings or leave an older checklist on screen. */
function todoEntries(value: unknown): TodoEntry[] {
  if (!Array.isArray(value)) return []
  const entries: TodoEntry[] = []
  for (const item of value) {
    const record = asRecord(item)
    const status = record?.status
    if (typeof record?.content !== 'string') continue
    if (typeof status !== 'string' || !TODO_STATUSES.has(status as TodoEntry['status'])) continue
    entries.push({ content: record.content, status: status as TodoEntry['status'] })
  }
  return entries
}

const TODO_GLYPHS: Readonly<Record<TodoEntry['status'], string>> = {
  pending: '☐',
  in_progress: '▸',
  completed: '☑',
}

/** What the reader most needs to see first: work in flight, then work left. */
function orderTodos(todos: readonly TodoEntry[]): readonly TodoEntry[] {
  const rank: Record<TodoEntry['status'], number> = { in_progress: 0, pending: 1, completed: 2 }
  return [...todos].sort((left, right) => rank[left.status] - rank[right.status])
}

/** The todo list as plain lines, for a reader who asked for it by name. */
export function describeTodos(todos: readonly TodoEntry[] | undefined, todoState: TodoState): string {
  if (todos === undefined || todos.length === 0) {
    return TODO_EMPTY_DESCRIPTIONS[todoState]
  }
  const done = todos.filter(todo => todo.status === 'completed').length
  const rows = orderTodos(todos).map(todo => `  ${TODO_GLYPHS[todo.status]} ${todo.content}`)
  return [`todos · ${done}/${todos.length} done`, ...rows].join('\n')
}

/**
 * Plan mode as the package that owns it reports it.
 *
 * The surface keeps no flag of its own: a session it has forgotten — cleared,
 * or one of several on screen — still answers for the agent being driven, and
 * only the host knows which selection is waiting for the turn boundary.
 */
export interface PlanModeState {
  /** The logged state. */
  readonly active: boolean
  /** A selection waiting for the next turn boundary; absent once it is applied. */
  readonly pending?: boolean
}

/** The plan controller, described structurally so the surface needs no import of it. */
interface PlanModeController {
  get(agent: unknown): unknown
}

/** The name the plan package registers under, in the container and in a preset scope. */
const PLAN_SERVICE = 'planMode'

/**
 * Where the surface asks for a service.
 *
 * A plugin a preset mounts behind `isolate` is invisible outside the group that
 * declares it, the host included, so the agent's own composition has to be
 * asked through its preset. The container is the fallback for a composition that
 * mounts the package flat.
 */
export interface ServiceLookup {
  readonly direct: (name: string) => unknown
  readonly forAgent: (agent: unknown, name: string) => unknown
}

function asController(value: unknown): PlanModeController | undefined {
  const record = asRecord(value)
  if (typeof record?.get !== 'function') return undefined
  return record as unknown as PlanModeController
}

function asPlanState(value: unknown): PlanModeState | undefined {
  const record = asRecord(value)
  if (typeof record?.active !== 'boolean') return undefined
  return typeof record.pending === 'boolean'
    ? { active: record.active, pending: record.pending }
    : { active: record.active }
}

/** The plan state of one agent, read from whichever scope of the composition holds it. */
export function readPlanState(lookup: ServiceLookup, agent: unknown): PlanModeState | undefined {
  const controller = asController(lookup.forAgent(agent, PLAN_SERVICE) ?? lookup.direct(PLAN_SERVICE))
  if (controller === undefined) return undefined
  return asPlanState(controller.get(agent))
}

/**
 * Whether plan mode is the state the agent is in, or is about to be in.
 *
 * A selection made inside a turn waits for the next accepted pre-step, so a
 * second press before that boundary has to read the selection: asking for the
 * logged state again would be a no-op, which the reader reads as a dead key.
 */
export function planSelectedActive(state: PlanModeState | undefined, fallback: boolean): boolean {
  if (state === undefined) return fallback
  return state.pending ?? state.active
}

/**
 * The command that asks for the other state.
 *
 * `/plan` enters and `/plan off` exits — neither toggles — so the surface names
 * the one it wants rather than keeping a flag that can drift from the host's.
 */
export function planToggleLine(active: boolean): string {
  return active ? '/plan off' : '/plan'
}

/**
 * Fold the agent's work state out of durable events.
 *
 * The state is folded rather than read from a service so a resumed session
 * shows exactly what the live one did, and so a composition without the
 * projection registry still tells the reader what the agent is doing. Each of
 * these events is a whole-value snapshot: the latest one wins. `turn/start`
 * also clears the todo list, matching the host projection's turn-boundary
 * lifetime so the dock and `/todo` never show a previous task's checklist.
 */
export class WorkFold {
  private planMode = false
  private todos: readonly TodoEntry[] | undefined
  private todoState: TodoState = TODO_STATES.neverWritten
  private goal: GoalState | undefined

  state(): WorkState {
    return this.planMode || this.todoState !== TODO_STATES.neverWritten || this.goal !== undefined
      ? { planMode: this.planMode, todos: this.todos, todoState: this.todoState, goal: this.goal }
      : EMPTY
  }

  reset(): void {
    this.planMode = false
    this.todos = undefined
    this.todoState = TODO_STATES.neverWritten
    this.goal = undefined
  }

  apply(event: FoldableEvent): void {
    const data = asRecord(event.data) ?? {}
    switch (event.type) {
      case 'plan/mode':
        this.planMode = data.active === true
        return
      case 'turn/start':
        // The host projection drops the standing plan when the next turn opens,
        // because a new task must not inherit the previous turn's checklist; the
        // fold follows the same rule or every surface disagrees.
        this.todos = undefined
        // A boundary cannot clear a checklist that this session never wrote.
        if (this.todoState !== TODO_STATES.neverWritten) this.todoState = TODO_STATES.turnCleared
        return
      case 'todo/write': {
        const entries = todoEntries(data.todos)
        // Keep the existing board projection; provenance prevents commands from mistaking emptiness for no writes.
        this.todos = entries.length === 0 ? undefined : entries
        this.todoState = TODO_STATES.written
        return
      }
      case 'goal/change': {
        if (data.operation === 'clear' || data.goal === undefined) {
          this.goal = undefined
          return
        }
        const goal = asRecord(data.goal)
        const objective = goal?.objective
        if (typeof objective !== 'string') return
        // Completion commits a full snapshot instead of a clear tombstone and
        // stays as the session's last goal: work that is over has to leave the
        // board, or its row keeps reading as a loop still running.
        if (data.operation === 'complete' || goal?.phase === 'complete') {
          this.goal = undefined
          return
        }
        const maxRounds = goal?.maxGoalRounds
        const roundsStarted = typeof data.roundsStarted === 'number'
          ? data.roundsStarted
          : typeof goal?.roundsStarted === 'number' ? goal.roundsStarted : 0
        const phase = goal?.phase
        this.goal = {
          objective,
          roundsStarted,
          maxRounds: typeof maxRounds === 'number' ? maxRounds : undefined,
          // A phase the harness did not name is a goal this fold cannot label as
          // stalled, so it reads as active rather than claiming more than it knows.
          phase: phase === 'paused' || phase === 'blocked' ? phase : 'active',
        }
        return
      }
      default:
        return
    }
  }
}
