import { visibleWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from '@earendil-works/pi-tui'
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
const SUBAGENTS_COLLAPSED_MARK = '▸'
const SUBAGENTS_EXPANDED_MARK = '▾'
const JOBS_MARK = '⛭'

/**
 * The dashed rule that opens a section, and the two dashes that lead its name.
 *
 * Dashed, because a section is live state that changes under the reader's eye
 * and a solid edge would claim the permanence of a border. The name rides the
 * rule the heading used to spend a row on, so the edge costs neither a row nor
 * a column of the rows a reader selects. Two dashes lead it: one would be read
 * as part of the mark the name already carries.
 */
const SECTION_RULE_DASH = '┄'
const SECTION_RULE_LEAD = `${SECTION_RULE_DASH}${SECTION_RULE_DASH} `

/** How one section is named, and the elements it is drawn in. */
interface DockSection {
  /** The name the section reports, spelled as its heading spelled it. */
  readonly heading: string
  /** The element the name is read in, and the row the section spends: no name, no row. */
  readonly headingToken: TuiToken
  /** The element the rule is drawn in; hiding it leaves the section as it was. */
  readonly borderToken: TuiToken
}

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
const SUBAGENT_ROW_INDENT = '  '

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
 * keeps its rows for the conversation. Each list it draws opens on a rule that
 * names it, in that section's own hue: the dock is several boards stacked, and
 * which board a row belongs to has to be readable without reading the row.
 */
export class WorkDock implements Component {
  /** A choice lasts while more than the preview's rows remain live. */
  private subagentsExpanded = false
  /** Rendered rows delimit the section even when its heading is hidden. */
  private subagentSection: { start: number; end: number; toggleable: boolean } | undefined
  /** Text spans retain full child ids; the drawn ids may be shortened. */
  private readonly subagentTexts = new Map<number, { id: string; endX: number }>()

  constructor(
    private readonly state: () => WorkState,
    private readonly theme: TuiTheme,
    /** Live background jobs: process state, not something a resume can replay. */
    private readonly jobs: () => readonly JobSummary[] = () => [],
    /** Delegations this session started; also live state. */
    private readonly subagents: () => readonly SubagentRun[] = () => [],
    /** Clock for elapsed times, so a frame can be pinned in a test. */
    private readonly now: () => number = () => Date.now(),
    /** A child opens through the same read-only transcript path as /subagents open. */
    private readonly openSubagent?: (id: string) => void,
  ) {}

  invalidate(): void {
    // Paint rebuilds click geometry; invalidation must preserve the reader’s fold choice.
  }

  /** Text opens its child; other cells in a foldable section control that fold. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== 'click' || event.button !== 'left') return undefined
    if (event.x < 0 || event.x >= event.width || event.y < 0 || event.y >= event.height) return undefined
    const text = this.subagentTexts.get(event.y)
    if (text !== undefined && event.x >= visibleWidth(SUBAGENT_ROW_INDENT) && event.x < text.endX) {
      if (this.openSubagent === undefined) return undefined
      this.openSubagent(text.id)
      return { handled: true, render: true }
    }
    const section = this.subagentSection
    if (section === undefined || !section.toggleable || event.y < section.start || event.y >= section.end) return undefined
    this.subagentsExpanded = !this.subagentsExpanded
    return { handled: true, render: true }
  }

  /**
   * The dashed rule that opens a section, with the section's name on it.
   *
   * A name with no room left for a dash after it is drawn as the heading it
   * would otherwise have been: a rule earns its row by being the edge of a
   * list, and an edge a reader cannot tell from a name is not one.
   */
  private sectionRule(width: number, section: DockSection): string {
    const head = `${SECTION_RULE_LEAD}${section.heading} `
    if (visibleWidth(head) + 1 > width) {
      return this.theme.style(section.headingToken, this.theme.cut(section.heading, width, '…'))
    }
    // Each run is painted on its own: a style wrapped around the finished row
    // would end where the name's own style ended, taking the dashes after it
    // with it, and the rule would lose the hue it is there to carry.
    const lead = this.theme.style(section.borderToken, SECTION_RULE_LEAD)
    const name = this.theme.style(section.headingToken, section.heading)
    const tail = this.theme.style(section.borderToken, ` ${SECTION_RULE_DASH.repeat(width - visibleWidth(head))}`)
    return `${lead}${name}${tail}`
  }

  /**
   * One section as the dock draws it: the rule that names it, then its rows.
   *
   * The rows arrive already built and are pushed as they are, so a section costs
   * the rows it always cost and no column of them. The name's element is what
   * spends the row: a hidden rule leaves the heading it replaced, and a hidden
   * name leaves the section exactly as it stood before the sections were edged —
   * a rule with no name to carry would be an edge that says nothing.
   */
  private pushSection(lines: string[], width: number, section: DockSection, rows: readonly string[]): void {
    if (this.theme.visible(section.headingToken)) {
      lines.push(this.theme.visible(section.borderToken)
        ? this.sectionRule(width, section)
        : this.theme.style(section.headingToken, this.theme.cut(section.heading, width, '…')))
    }
    lines.push(...rows)
  }

  private pushTodos(lines: string[], todos: readonly TodoEntry[], width: number): void {
    // Settled items leave the dock: it reports what is still to do, and a row
    // that stayed after its item finished would only grow the list as the turn
    // went on.
    const open = todos.filter(isOpenTodo)
    if (open.length === 0) return
    const ordered = orderTodos(open)
    const rows: string[] = []
    for (const todo of ordered.slice(0, DOCK_TODO_LIMIT)) {
      const token = TODO_TOKENS[todo.status]
      if (!this.theme.visible(token)) continue
      const lead = `  ${TODO_GLYPHS[todo.status]} `
      rows.push(this.theme.cut(this.theme.rich(`${lead}${todo.content}`, { token, column: visibleWidth(lead) }), width, '…'))
    }
    if (ordered.length > DOCK_TODO_LIMIT && this.theme.visible('dock.todos.overflow')) {
      rows.push(this.theme.style('dock.todos.overflow', this.theme.cut(`  … ${ordered.length - DOCK_TODO_LIMIT} more`, width, '…')))
    }
    this.pushSection(lines, width, {
      heading: `${TODOS_MARK} todos · ${open.length} left`,
      headingToken: 'dock.todos.heading',
      borderToken: 'dock.todos.border',
    }, rows)
  }

  private pushSubagents(lines: string[], runs: readonly SubagentRun[], width: number): void {
    // A delegation that has reported back is no longer something to watch, for
    // the same reason a settled job leaves: the dock holds work in flight.
    const running = runs.filter(run => run.status === 'running')
    if (running.length <= DOCK_SUBAGENT_LIMIT) this.subagentsExpanded = false
    if (running.length === 0) return
    const start = lines.length
    const headingRows = this.theme.visible('dock.subagents.heading') ? 1 : 0
    const limit = this.subagentsExpanded ? running.length : DOCK_SUBAGENT_LIMIT
    const now = this.now()
    const rows: string[] = []
    for (const run of running.slice(0, limit)) {
      if (!this.theme.visible('dock.subagents.running')) continue
      const lead = `${SUBAGENT_ROW_INDENT}${RUNNING_MARK} `
      const row = this.theme.cut(this.theme.rich(`${lead}${describeSubagent(run, now)}`, { token: 'dock.subagents.running', column: visibleWidth(lead) }), width, '…')
      this.subagentTexts.set(start + headingRows + rows.length, { id: run.id, endX: visibleWidth(row) })
      rows.push(row)
    }
    if (running.length > limit && this.theme.visible('dock.subagents.overflow')) {
      rows.push(this.theme.style('dock.subagents.overflow', this.theme.cut(`  … ${running.length - limit} more`, width, '…')))
    }
    const foldMark = running.length <= DOCK_SUBAGENT_LIMIT ? '' : ` ${this.subagentsExpanded ? SUBAGENTS_EXPANDED_MARK : SUBAGENTS_COLLAPSED_MARK}`
    this.pushSection(lines, width, {
      heading: `${SUBAGENTS_MARK} subagents${foldMark} · ${running.length} running`,
      headingToken: 'dock.subagents.heading',
      borderToken: 'dock.subagents.border',
    }, rows)
    this.subagentSection = { start, end: lines.length, toggleable: running.length > DOCK_SUBAGENT_LIMIT }
  }

  private pushJobs(lines: string[], jobs: readonly JobSummary[], width: number): void {
    // Only work still holding resources earns a row: a settled job is a fact the
    // reader no longer has to watch, and its row would otherwise linger after
    // the outcome it reported had been read.
    const live = jobs.filter(job => isLive(job.status))
    if (live.length === 0) return
    const ordered = [...live].sort((left, right) => right.startedAt - left.startedAt)
    const now = this.now()
    const rows: string[] = []
    for (const job of ordered.slice(0, DOCK_JOB_LIMIT)) {
      if (!this.theme.visible('dock.jobs.running')) continue
      const lead = `  ${RUNNING_MARK} `
      rows.push(this.theme.cut(this.theme.rich(`${lead}${describeJob(job, now)}`, { token: 'dock.jobs.running', column: visibleWidth(lead) }), width, '…'))
    }
    if (ordered.length > DOCK_JOB_LIMIT && this.theme.visible('dock.jobs.overflow')) {
      rows.push(this.theme.style('dock.jobs.overflow', this.theme.cut(`  … ${ordered.length - DOCK_JOB_LIMIT} more`, width, '…')))
    }
    this.pushSection(lines, width, {
      heading: `${JOBS_MARK} jobs · ${live.length} running`,
      headingToken: 'dock.jobs.heading',
      borderToken: 'dock.jobs.border',
    }, rows)
  }

  render(width: number): string[] {
    this.subagentSection = undefined
    this.subagentTexts.clear()
    if (width <= 0) return []
    const state = this.state()
    const lines: string[] = []
    if (state.goal !== undefined && this.theme.visible('dock.goal')) {
      const rounds = state.goal.maxRounds === undefined
        ? `round ${state.goal.roundsStarted}`
        : `round ${state.goal.roundsStarted}/${state.goal.maxRounds}`
      // A stalled goal has to say so on the row: the round counter alone would
      // let a paused or blocked objective read as a loop still making progress.
      const phase = state.goal.phase === 'active' ? '' : `${state.goal.phase} · `
      // The row itself decides where a long objective ends, so the reader
      // always sees that something was left out.
      const objective = state.goal.objective.replace(/\s+/gu, ' ')
      const lead = `${GOAL_MARK} goal ${phase}${rounds} · `
      lines.push(this.theme.cut(this.theme.rich(`${lead}${objective}`, { token: 'dock.goal', column: visibleWidth(lead) }), width, '…'))
    }
    if (state.planMode && this.theme.visible('dock.planMode')) {
      lines.push(this.theme.style('dock.planMode', this.theme.cut(`${PLAN_MODE_MARK} plan mode · answer the plan before edits happen`, width, '…')))
    }
    const subagents = this.subagents()
    this.pushSubagents(lines, subagents, width)
    const jobs = this.jobs()
    if (jobs.length > 0) this.pushJobs(lines, jobs, width)
    if (state.todos !== undefined) this.pushTodos(lines, state.todos, width)
    return lines
  }
}
