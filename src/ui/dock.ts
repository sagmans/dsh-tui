import { type Component, truncateToWidth } from '@earendil-works/pi-tui'
import { DOCK_JOB_LIMIT, describeJob, isLive, type JobSummary } from '../jobs.ts'
import { displayText } from '../text.ts'
import type { TuiTheme } from '../theme.ts'
import type { TodoEntry, WorkState } from '../work.ts'

/** Todo rows the dock keeps on screen; the rest become a count. */
export const DOCK_TODO_LIMIT = 4

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
  ) {}

  invalidate(): void {
    // The fold is the only state; nothing is cached.
  }

  private pushTodos(lines: string[], todos: readonly TodoEntry[], width: number): void {
    const done = todos.filter(todo => todo.status === 'completed').length
    lines.push(this.theme.bold(truncateToWidth(`☰ todos ${done}/${todos.length} done`, width, '…')))
    const ordered = orderTodos(todos)
    for (const todo of ordered.slice(0, DOCK_TODO_LIMIT)) {
      lines.push(this.theme.dim(truncateToWidth(`  ${TODO_GLYPHS[todo.status]} ${displayText(todo.content)}`, width, '…')))
    }
    if (ordered.length > DOCK_TODO_LIMIT) {
      lines.push(this.theme.dim(truncateToWidth(`  … ${ordered.length - DOCK_TODO_LIMIT} more`, width, '…')))
    }
  }

  private pushJobs(lines: string[], jobs: readonly JobSummary[], width: number): void {
    const live = jobs.filter(job => isLive(job.status)).length
    lines.push(this.theme.bold(truncateToWidth(`⛭ jobs · ${live} running, ${jobs.length - live} done`, width, '…')))
    // Work still holding resources first, then the most recent.
    const ordered = [...jobs].sort((left, right) =>
      Number(isLive(right.status)) - Number(isLive(left.status)) || right.startedAt - left.startedAt)
    const now = Date.now()
    for (const job of ordered.slice(0, DOCK_JOB_LIMIT)) {
      const glyph = isLive(job.status) ? '▸' : job.status === 'completed' ? '✓' : '✗'
      lines.push(this.theme.dim(truncateToWidth(`  ${glyph} ${displayText(describeJob(job, now))}`, width, '…')))
    }
    if (ordered.length > DOCK_JOB_LIMIT) {
      lines.push(this.theme.dim(truncateToWidth(`  … ${ordered.length - DOCK_JOB_LIMIT} more`, width, '…')))
    }
  }

  render(width: number): string[] {
    if (width <= 0) return []
    const state = this.state()
    const lines: string[] = []
    if (state.goal !== undefined) {
      const rounds = state.goal.maxRounds === undefined
        ? `round ${state.goal.roundsStarted}`
        : `round ${state.goal.roundsStarted}/${state.goal.maxRounds}`
      // The row itself decides where a long objective ends, so the reader
      // always sees that something was left out.
      const objective = state.goal.objective.replace(/\s+/gu, ' ')
      lines.push(this.theme.bold(truncateToWidth(`◎ goal ${rounds} · ${displayText(objective)}`, width, '…')))
    }
    if (state.planMode) {
      lines.push(this.theme.bold(truncateToWidth('⏸ plan mode · answer the plan before edits happen', width, '…')))
    }
    const jobs = this.jobs()
    if (jobs.length > 0) this.pushJobs(lines, jobs, width)
    if (state.todos !== undefined) this.pushTodos(lines, state.todos, width)
    return lines
  }
}
