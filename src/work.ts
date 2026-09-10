import type { FoldableEvent } from './transcript.ts'

/** One entry of the agent's todo list, as the tool writes it. */
export interface TodoEntry {
  readonly content: string
  readonly status: 'pending' | 'in_progress' | 'completed'
}

/** The goal a continuation loop is driving, when one is set. */
export interface GoalState {
  readonly objective: string
  readonly roundsStarted: number
  readonly maxRounds: number | undefined
}

/** What the agent is working on, folded from durable events. */
export interface WorkState {
  readonly planMode: boolean
  readonly todos: readonly TodoEntry[] | undefined
  readonly goal: GoalState | undefined
}

const EMPTY: WorkState = { planMode: false, todos: undefined, goal: undefined }

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

const TODO_STATUSES = new Set<TodoEntry['status']>(['pending', 'in_progress', 'completed'])

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

/**
 * Fold the agent's work state out of durable events.
 *
 * The state is folded rather than read from a service so a resumed session
 * shows exactly what the live one did, and so a composition without the
 * projection registry still tells the reader what the agent is doing. Each of
 * these events is a whole-value snapshot: the latest one wins.
 */
export class WorkFold {
  private planMode = false
  private todos: readonly TodoEntry[] | undefined
  private goal: GoalState | undefined

  state(): WorkState {
    return this.planMode || this.todos !== undefined || this.goal !== undefined
      ? { planMode: this.planMode, todos: this.todos, goal: this.goal }
      : EMPTY
  }

  reset(): void {
    this.planMode = false
    this.todos = undefined
    this.goal = undefined
  }

  apply(event: FoldableEvent): void {
    const data = asRecord(event.data) ?? {}
    switch (event.type) {
      case 'plan/mode':
        this.planMode = data.active === true
        return
      case 'todo/write': {
        const entries = todoEntries(data.todos)
        this.todos = entries.length === 0 ? undefined : entries
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
        const maxRounds = goal?.maxGoalRounds
        const roundsStarted = typeof data.roundsStarted === 'number'
          ? data.roundsStarted
          : typeof goal?.roundsStarted === 'number' ? goal.roundsStarted : 0
        this.goal = {
          objective,
          roundsStarted,
          maxRounds: typeof maxRounds === 'number' ? maxRounds : undefined,
        }
        return
      }
      default:
        return
    }
  }
}
