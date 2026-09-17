import { type Component } from '@earendil-works/pi-tui'
import { DOCK_JOB_LIMIT, describeJob, isLive, type JobStatus, type JobSummary } from '../jobs.ts'
import { DOCK_SUBAGENT_LIMIT, describeSubagent, type SubagentRun } from '../subagents.ts'
import { displayText } from '../text.ts'
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

/** The row marks, by the state the row reports. */
const TODO_GLYPHS: Readonly<Record<TodoEntry['status'], string>> = {
  pending: '☐',
  in_progress: '▸',
  completed: '☑',
}
const RUN_GLYPHS: Readonly<Record<'running' | 'completed' | 'failed', string>> = {
  running: '▸',
  completed: '✓',
  failed: '✗',
}

/** Each todo state is its own element, so one can be toned without the others. */
const TODO_TOKENS: Readonly<Record<TodoEntry['status'], TuiToken>> = {
  pending: 'dock.todos.pending',
  in_progress: 'dock.todos.inProgress',
  completed: 'dock.todos.completed',
}

/** A delegation or job reports the outcome, so its row names the matching element. */
const SUBAGENT_TOKENS: Readonly<Record<SubagentRun['status'], TuiToken>> = {
  running: 'dock.subagents.running',
  completed: 'dock.subagents.completed',
  failed: 'dock.subagents.failed',
}

/** A job is only ever live, finished, or stopped, and the last two read the same to a reader. */
function jobOutcome(status: JobStatus): 'running' | 'completed' | 'failed' {
  if (isLive(status)) return 'running'
  return status === 'completed' ? 'completed' : 'failed'
}
const JOB_TOKENS: Readonly<Record<'running' | 'completed' | 'failed', TuiToken>> = {
  running: 'dock.jobs.running',
  completed: 'dock.jobs.completed',
  failed: 'dock.jobs.failed',
}

/** What the reader most needs to see first: work in flight, then work left. */
function orderTodos(todos: readonly TodoEntry[]): readonly TodoEntry[] {
  const rank: Record<TodoEntry['status'], number> = { in_progress: 0, pending: 1, completed: 2 }
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
    const done = todos.filter(todo => todo.status === 'completed').length
    if (this.theme.visible('dock.todos.heading')) {
      lines.push(this.theme.style('dock.todos.heading', this.theme.cut(`${TODOS_MARK} todos ${done}/${todos.length} done`, width, '…')))
    }
    const ordered = orderTodos(todos)
    for (const todo of ordered.slice(0, DOCK_TODO_LIMIT)) {
      const token = TODO_TOKENS[todo.status]
      if (!this.theme.visible(token)) continue
      lines.push(this.theme.style(token, this.theme.cut(`  ${TODO_GLYPHS[todo.status]} ${displayText(todo.content)}`, width, '…')))
    }
    if (ordered.length > DOCK_TODO_LIMIT && this.theme.visible('dock.todos.overflow')) {
      lines.push(this.theme.style('dock.todos.overflow', this.theme.cut(`  … ${ordered.length - DOCK_TODO_LIMIT} more`, width, '…')))
    }
  }

  private pushSubagents(lines: string[], runs: readonly SubagentRun[], width: number): void {
    const running = runs.filter(run => run.status === 'running').length
    if (this.theme.visible('dock.subagents.heading')) {
      lines.push(this.theme.style('dock.subagents.heading', this.theme.cut(`${SUBAGENTS_MARK} subagents · ${running} running, ${runs.length - running} done`, width, '…')))
    }
    const now = this.now()
    for (const run of runs.slice(0, DOCK_SUBAGENT_LIMIT)) {
      const token = SUBAGENT_TOKENS[run.status]
      if (!this.theme.visible(token)) continue
      lines.push(this.theme.style(token, this.theme.cut(`  ${RUN_GLYPHS[run.status]} ${displayText(describeSubagent(run, now))}`, width, '…')))
    }
    if (runs.length > DOCK_SUBAGENT_LIMIT && this.theme.visible('dock.subagents.overflow')) {
      lines.push(this.theme.style('dock.subagents.overflow', this.theme.cut(`  … ${runs.length - DOCK_SUBAGENT_LIMIT} more`, width, '…')))
    }
  }

  private pushJobs(lines: string[], jobs: readonly JobSummary[], width: number): void {
    const live = jobs.filter(job => isLive(job.status)).length
    if (this.theme.visible('dock.jobs.heading')) {
      lines.push(this.theme.style('dock.jobs.heading', this.theme.cut(`${JOBS_MARK} jobs · ${live} running, ${jobs.length - live} done`, width, '…')))
    }
    // Work still holding resources first, then the most recent.
    const ordered = [...jobs].sort((left, right) =>
      Number(isLive(right.status)) - Number(isLive(left.status)) || right.startedAt - left.startedAt)
    const now = this.now()
    for (const job of ordered.slice(0, DOCK_JOB_LIMIT)) {
      const outcome = jobOutcome(job.status)
      const token = JOB_TOKENS[outcome]
      if (!this.theme.visible(token)) continue
      lines.push(this.theme.style(token, this.theme.cut(`  ${RUN_GLYPHS[outcome]} ${displayText(describeJob(job, now))}`, width, '…')))
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
      lines.push(this.theme.style('dock.goal', this.theme.cut(`${GOAL_MARK} goal ${rounds} · ${displayText(objective)}`, width, '…')))
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
