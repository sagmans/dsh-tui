import type {
  GoalRef,
  MessageId,
  SessionId,
} from '@deepseek-ai/dsh-client-connection/client'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { defineTuiAction } from '../../contracts/actions.js'
import {
  OPERATION_ACTION_SCOPE,
  type OperationActionView,
  type OperationRowState,
  type OperationRowView,
  type OperationsListState,
  type OperationsSection,
  type FeedbackItemView,
} from './contracts.js'
import type { WorkflowPresentation } from '../conversation/contracts.js'
import { record } from '../../client/conversation/shared.js'
import { sanitizeConversationText } from '../conversation/projection.js'
import { feedbackRows, trajectoryRows } from './history.js'

const GOAL_EDIT: OperationActionView = defineTuiAction(OPERATION_ACTION_SCOPE, 'goal.edit', 'EDIT', 'default')
const GOAL_PAUSE: OperationActionView = defineTuiAction(OPERATION_ACTION_SCOPE, 'goal.pause', 'PAUSE', 'default')
const GOAL_RESUME: OperationActionView = defineTuiAction(OPERATION_ACTION_SCOPE, 'goal.resume', 'RESUME', 'positive')
const GOAL_COMPLETE: OperationActionView = defineTuiAction(OPERATION_ACTION_SCOPE, 'goal.complete', 'COMPLETE', 'positive')
const GOAL_CLEAR: OperationActionView = defineTuiAction(OPERATION_ACTION_SCOPE, 'goal.clear', 'CLEAR', 'danger')
const PLAN_OFF: OperationActionView = defineTuiAction(OPERATION_ACTION_SCOPE, 'plan.off', 'EXIT PLAN', 'default')
const OPEN_WORKFLOW: OperationActionView = defineTuiAction(OPERATION_ACTION_SCOPE, 'workflow.open', 'OPEN', 'default')
const OPEN_SUBAGENT: OperationActionView = defineTuiAction(OPERATION_ACTION_SCOPE, 'subagent.open', 'OPEN', 'default')
interface GoalView {
  readonly maxGoalRounds: number
  readonly objective: string
  readonly phase: 'active' | 'blocked' | 'complete' | 'paused'
  readonly ref: GoalRef
  readonly roundsStarted: number
}

export type OperationTarget =
  | { readonly kind: 'feedback'; readonly item: FeedbackItemView | undefined; readonly messageId: MessageId }
  | { readonly goal: GoalView; readonly kind: 'goal' }
  | { readonly kind: 'job' }
  | { readonly kind: 'plan' }
  | { readonly kind: 'subagent'; readonly childId: SessionId; readonly mode: 'continuable' | 'one-shot' }
  | { readonly kind: 'trajectory' }
  | { readonly childId: SessionId; readonly kind: 'workflow' }

export interface ProjectedOperations {
  readonly rows: readonly OperationRowView[]
  readonly targets: ReadonlyMap<string, OperationTarget>
}

export interface OperationsProjectionInput {
  readonly conversation: ConversationSnapshot | undefined
  readonly feedback: ReadonlyMap<string, FeedbackItemView>
  readonly feedbackError: string | undefined
  readonly feedbackLoading: boolean
  readonly list: OperationsListState
  readonly section: OperationsSection
}

function safe(value: string): string {
  return sanitizeConversationText(value)
}

function field(value: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const candidate = value[key]
  return typeof candidate === 'string' ? candidate : undefined
}

function goalRef(id: string, revision: number): GoalRef {
  // Projection values carry the same opaque Goal identity accepted by the generated Remote API.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return { id, revision } as GoalRef
}

function goalOf(list: OperationsListState): GoalView | undefined {
  const current = list.current
  const values: unknown = current === undefined ? undefined : list.byId[current]?.projectionValues
  if (!record(values)) return undefined
  const projection = values.goal
  if (!record(projection) || !record(projection.goal)) return undefined
  const goal = projection.goal
  const id = field(goal, 'id')
  const objective = field(goal, 'objective')
  const phase = field(goal, 'phase')
  if (id === undefined
    || objective === undefined
    || (phase !== 'active' && phase !== 'blocked' && phase !== 'complete' && phase !== 'paused')
    || typeof goal.revision !== 'number'
    || !Number.isSafeInteger(goal.revision)
    || typeof goal.maxGoalRounds !== 'number'
    || !Number.isSafeInteger(goal.maxGoalRounds)) {
    return undefined
  }
  return {
    maxGoalRounds: goal.maxGoalRounds,
    objective: safe(objective),
    phase,
    ref: goalRef(id, goal.revision),
    roundsStarted: typeof projection.roundsStarted === 'number' && Number.isSafeInteger(projection.roundsStarted)
      ? projection.roundsStarted
      : 0,
  }
}

function goalActions(phase: GoalView['phase']): readonly OperationActionView[] {
  switch (phase) {
    case 'active': return [GOAL_PAUSE, GOAL_EDIT, GOAL_COMPLETE, GOAL_CLEAR]
    case 'paused': return [GOAL_RESUME, GOAL_EDIT, GOAL_COMPLETE, GOAL_CLEAR]
    case 'blocked': return [GOAL_EDIT, GOAL_COMPLETE, GOAL_CLEAR]
    case 'complete': return [GOAL_CLEAR]
    default: {
      const exhaustive: never = phase
      return exhaustive
    }
  }
}

function goalRows(input: OperationsProjectionInput, targets: Map<string, OperationTarget>): readonly OperationRowView[] {
  const goal = goalOf(input.list)
  if (goal === undefined) return []
  const id = `goal:${goal.ref.id}`
  targets.set(id, { goal, kind: 'goal' })
  return [{
    actions: goalActions(goal.phase),
    details: `${goal.objective}\nrounds ${goal.roundsStarted}/${goal.maxGoalRounds}\nrevision ${goal.ref.revision}`,
    id,
    state: goal.phase === 'active' ? 'running' : goal.phase === 'complete' ? 'success' : 'warning',
    summary: `${goal.phase} · round ${goal.roundsStarted}/${goal.maxGoalRounds}`,
    title: goal.objective,
  }]
}

function planRows(input: OperationsProjectionInput, targets: Map<string, OperationTarget>): readonly OperationRowView[] {
  const current = input.list.current
  const values: unknown = current === undefined ? undefined : input.list.byId[current]?.projectionValues
  const plan = record(values) && record(values.plan) ? values.plan : undefined
  if (plan === undefined || typeof plan.active !== 'boolean' || typeof plan.pending !== 'boolean') return []
  const target = plan.pending ? !plan.active : plan.active
  const id = 'plan:current'
  targets.set(id, { kind: 'plan' })
  return [{
    actions: target ? [PLAN_OFF] : [],
    details: `active ${String(plan.active)}\npending ${String(plan.pending)}`,
    id,
    state: plan.pending ? 'warning' : target ? 'running' : 'idle',
    summary: plan.pending ? 'transition pending' : target ? 'active' : 'inactive',
    title: 'Plan mode',
  }]
}

function workflowsOf(conversation: ConversationSnapshot | undefined): readonly WorkflowPresentation[] {
  return conversation?.views.get('tui')?.workflows ?? []
}

function workflowRows(input: OperationsProjectionInput, targets: Map<string, OperationTarget>): readonly OperationRowView[] {
  const parentId = input.list.current
  return workflowsOf(input.conversation).flatMap((workflow) => {
    if (workflow.members.length === 0) {
      return [{
        actions: [],
        details: `run ${workflow.id}`,
        id: `workflow:${workflow.id}`,
        state: stateOf(workflow.status),
        summary: `${workflow.status} · no members`,
        title: safe(workflow.name),
      } satisfies OperationRowView]
    }
    return workflow.members.map((member, index): OperationRowView => {
      const summary = input.list.byId[member.childId]
      const navigable = parentId !== undefined
        && member.status === 'running'
        && summary?.origin === 'subagent'
        && summary.parentId === parentId
        && summary.running
      const id = `workflow:${workflow.id}:${index}`
      if (navigable) targets.set(id, { childId: member.childId, kind: 'workflow' })
      return {
        actions: navigable ? [OPEN_WORKFLOW] : [],
        details: `run ${workflow.id}\nchild ${member.childId}\nphase ${member.phase ?? '(unassigned)'}`,
        id,
        state: stateOf(member.status),
        summary: `${member.phase ?? 'unassigned'} · ${member.status}`,
        title: `${safe(workflow.name)} · ${safe(member.label === '' ? String(member.childId) : member.label)}`,
      }
    })
  })
}

function stateOf(status: string): OperationRowState {
  switch (status) {
    case 'running':
    case 'stopping': return 'running'
    case 'completed': return 'success'
    case 'failed': return 'error'
    case 'cancelled':
    case 'interrupted':
    case 'killed': return 'warning'
    default: return 'idle'
  }
}

function jobRows(input: OperationsProjectionInput, targets: Map<string, OperationTarget>): readonly OperationRowView[] {
  const current = input.list.current
  const jobs = current === undefined ? [] : input.list.jobsBySession[current] ?? []
  return jobs.toSorted((left, right) => {
    const leftLive = left.status === 'running' || left.status === 'stopping'
    const rightLive = right.status === 'running' || right.status === 'stopping'
    if (leftLive !== rightLive) return leftLive ? -1 : 1
    return leftLive
      ? left.startedAt - right.startedAt
      : (right.finishedAt ?? right.startedAt) - (left.finishedAt ?? left.startedAt)
  }).map(job => {
    const id = `job:${job.id}`
    targets.set(id, { kind: 'job' })
    return {
      actions: [],
      details: `${safe(job.kind)}\nstarted ${job.startedAt}${job.finishedAt === undefined ? '' : `\nfinished ${job.finishedAt}`}`,
      id,
      state: stateOf(job.status),
      summary: safe(job.detail ?? job.status),
      title: safe(job.label),
    }
  })
}

function subagentRows(input: OperationsProjectionInput, targets: Map<string, OperationTarget>): readonly OperationRowView[] {
  const parentId = input.list.current
  const catalog = parentId === undefined ? undefined : input.list.subagentsByParent[parentId]
  if (catalog === undefined) return []
  return catalog.entries.map((entry): OperationRowView => {
    const id = `subagent:${entry.id}`
    if (entry.kind === 'diagnostic') {
      return { actions: [], details: String(entry.id), id, state: 'error', summary: entry.reason, title: String(entry.id) }
    }
    targets.set(id, { childId: entry.id, kind: 'subagent', mode: entry.mode })
    return {
      actions: [OPEN_SUBAGENT],
      details: `child ${entry.id}\nmode ${entry.mode}\nchildren ${String(entry.hasChildren)}\nparent ${catalog.parentAvailable ? 'available' : 'unavailable'}`,
      id,
      state: entry.activity === 'running' ? 'running' : 'idle',
      summary: `${entry.mode} · ${entry.activity}`,
      title: safe(entry.label ?? String(entry.id)),
    }
  })
}

export function projectOperations(input: OperationsProjectionInput): ProjectedOperations {
  const targets = new Map<string, OperationTarget>()
  let rows: readonly OperationRowView[]
  switch (input.section) {
    case 'goal': rows = goalRows(input, targets); break
    case 'plan': rows = planRows(input, targets); break
    case 'workflows': rows = workflowRows(input, targets); break
    case 'jobs': rows = jobRows(input, targets); break
    case 'subagents': rows = subagentRows(input, targets); break
    case 'trajectory': rows = trajectoryRows(input, targets); break
    case 'feedback': rows = feedbackRows(input, targets); break
    default: {
      const exhaustive: never = input.section
      rows = exhaustive
    }
  }
  return { rows: Object.freeze(rows), targets }
}
