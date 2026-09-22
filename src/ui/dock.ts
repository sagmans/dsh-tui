import { visibleWidth, type Component } from '@earendil-works/pi-tui'
import { DOCK_JOB_LIMIT, describeJob, isLive, type JobSummary } from '../jobs.ts'
import { DOCK_SUBAGENT_LIMIT, describeSubagent, type SubagentRun } from '../subagents.ts'
import type { TuiToken } from '../theme-tokens.ts'
import type { TuiTheme } from '../theme.ts'
import type { TodoEntry, WorkState } from '../work.ts'

/** Todo rows the dock keeps on screen; the rest become a count. */
export const DOCK_TODO_LIMIT = 4

/** The mark that introduces a dock section, so a literal never lives in a template. */
const GOAL_MARK = '◎'
const PLAN_MODE_MARK = '⏸'
const TODOS_MARK = '☰'
const SUBAGENTS_MARK = '⚇'
const JOBS_MARK = '⛭'

/** A todo state the dock draws: a settled item is not work left, so it is not one. */
type OpenTodoStatus = Exclude<TodoEntry['status'], 'completed'>

/** A todo that is still to do, with the state narrowed to the ones the dock draws. */
type OpenTodo = TodoEntry & { readonly status: OpenTodoStatus }

/** Whether a todo is still owed to the reader, narrowing it to the states the dock draws. */
const isOpenTodo = (todo: TodoEntry): todo is OpenTodo => todo.status !== 'completed'

/** The row marks, by the state the row reports. */
const TODO_GLYPHS: Readonly<Record<OpenTodoStatus, string>> = {
  pending: '☐',
  in_progress: '▸',
}
/** The mark a row that is still in flight carries, for a job and a delegation alike. */
const RUNNING_MARK = '▸'

/** Each todo state is its own element, so one can be toned without the others. */
const TODO_TOKENS: Readonly<Record<OpenTodoStatus, TuiToken>> = {
  pending: 'dock.todos.pending',
  in_progress: 'dock.todos.inProgress',
}

/** What the reader most needs to see first: work in flight, then work left. */
function orderTodos(todos: readonly OpenTodo[]): readonly OpenTodo[] {
  const rank: Record<OpenTodoStatus, number> = { in_progress: 0, pending: 1 }
  return [...todos].sort((left, right) => rank[left.status] - rank[right.status])
}

/**
 * The dock above the editor: what the agent is working on right now.
 *
 * It renders nothing when there is nothing to say, so a plain conversation
 * keeps its rows for the conversation.
 */
export class WorkDock implements Component {
  constructor(
    private readonly state: () => WorkState,
    private readonly theme: TuiTheme,
    /** Live background jobs: process state, not something a resume can replay. */
    private readonly jobs: () => readonly JobSummary[] = () => [],
    /** Delegations this session started; also live state. */
    private readonly subagents: () => readonly SubagentRun[] = () => [],
    /** Clock for elapsed times, so a frame can be pinned in a test. */
    private readonly now: () => number = () => Date.now(),
  ) {}

  invalidate(): void {
    // The fold is the only state; nothing is cached.
  }

  private pushTodos(lines: string[], todos: readonly TodoEntry[], width: number): void {
    // Settled items leave the dock: it reports what is still to do, and a row
    // that stayed after its item finished would only grow the list as the turn
    // went on.
    const open = todos.filter(isOpenTodo)
    if (open.length === 0) return
    if (this.theme.visible('dock.todos.heading')) {
      lines.push(this.theme.style('dock.todos.heading', this.theme.cut(`${TODOS_MARK} todos · ${open.length} left`, width, '…')))
    }
    const ordered = orderTodos(open)
    for (const todo of ordered.slice(0, DOCK_TODO_LIMIT)) {
      const token = TODO_TOKENS[todo.status]
      if (!this.theme.visible(token)) continue
      const lead = `  ${TODO_GLYPHS[todo.status]} `
      lines.push(this.theme.cut(this.theme.rich(`${lead}${todo.content}`, { token, column: visibleWidth(lead) }), width, '…'))
    }
    if (ordered.length > DOCK_TODO_LIMIT && this.theme.visible('dock.todos.overflow')) {
      lines.push(this.theme.style('dock.todos.overflow', this.theme.cut(`  … ${ordered.length - DOCK_TODO_LIMIT} more`, width, '…')))
    }
  }

  private pushSubagents(lines: string[], runs: readonly SubagentRun[], width: number): void {
    // A delegation that has reported back is no longer something to watch, for
    // the same reason a settled job leaves: the dock holds work in flight.
    const running = runs.filter(run => run.status === 'running')
    if (running.length === 0) return
    if (this.theme.visible('dock.subagents.heading')) {
      lines.push(this.theme.style('dock.subagents.heading', this.theme.cut(`${SUBAGENTS_MARK} subagents · ${running.length} running`, width, '…')))
    }
    const now = this.now()
    for (const run of running.slice(0, DOCK_SUBAGENT_LIMIT)) {
      if (!this.theme.visible('dock.subagents.running')) continue
      const lead = `  ${RUNNING_MARK} `
      lines.push(this.theme.cut(this.theme.rich(`${lead}${describeSubagent(run, now)}`, { token: 'dock.subagents.running', column: visibleWidth(lead) }), width, '…'))
    }
    if (running.length > DOCK_SUBAGENT_LIMIT && this.theme.visible('dock.subagents.overflow')) {
      lines.push(this.theme.style('dock.subagents.overflow', this.theme.cut(`  … ${running.length - DOCK_SUBAGENT_LIMIT} more`, width, '…')))
    }
  }

  private pushJobs(lines: string[], jobs: readonly JobSummary[], width: number): void {
    // Only work still holding resources earns a row: a settled job is a fact the
    // reader no longer has to watch, and its row would otherwise linger after
    // the outcome it reported had been read.
    const live = jobs.filter(job => isLive(job.status))
    if (live.length === 0) return
    if (this.theme.visible('dock.jobs.heading')) {
      lines.push(this.theme.style('dock.jobs.heading', this.theme.cut(`${JOBS_MARK} jobs · ${live.length} running`, width, '…')))
    }
    const ordered = [...live].sort((left, right) => right.startedAt - left.startedAt)
    const now = this.now()
    for (const job of ordered.slice(0, DOCK_JOB_LIMIT)) {
      if (!this.theme.visible('dock.jobs.running')) continue
      const lead = `  ${RUNNING_MARK} `
      lines.push(this.theme.cut(this.theme.rich(`${lead}${describeJob(job, now)}`, { token: 'dock.jobs.running', column: visibleWidth(lead) }), width, '…'))
    }
    if (ordered.length > DOCK_JOB_LIMIT && this.theme.visible('dock.jobs.overflow')) {
      lines.push(this.theme.style('dock.jobs.overflow', this.theme.cut(`  … ${ordered.length - DOCK_JOB_LIMIT} more`, width, '…')))
    }
  }

  render(width: number): string[] {
    if (width <= 0) return []
    const state = this.state()
    const lines: string[] = []
    if (state.goal !== undefined && this.theme.visible('dock.goal')) {
      const rounds = state.goal.maxRounds === undefined
        ? `round ${state.goal.roundsStarted}`
        : `round ${state.goal.roundsStarted}/${state.goal.maxRounds}`
      // The row itself decides where a long objective ends, so the reader
      // always sees that something was left out.
      const objective = state.goal.objective.replace(/\s+/gu, ' ')
      const lead = `${GOAL_MARK} goal ${rounds} · `
      lines.push(this.theme.cut(this.theme.rich(`${lead}${objective}`, { token: 'dock.goal', column: visibleWidth(lead) }), width, '…'))
    }
    if (state.planMode && this.theme.visible('dock.planMode')) {
      lines.push(this.theme.style('dock.planMode', this.theme.cut(`${PLAN_MODE_MARK} plan mode · answer the plan before edits happen`, width, '…')))
    }
    const subagents = this.subagents()
    if (subagents.length > 0) this.pushSubagents(lines, subagents, width)
    const jobs = this.jobs()
    if (jobs.length > 0) this.pushJobs(lines, jobs, width)
    if (state.todos !== undefined) this.pushTodos(lines, state.todos, width)
    return lines
  }
}
