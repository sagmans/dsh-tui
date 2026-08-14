import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ConversationLocation,
  ConversationMatch,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  WorkflowMemberPresentation,
  WorkflowPresentation,
  WorkflowRunStatus,
} from '../../features/conversation/contracts.js'
import {
  eventType,
  MAIN_PRIORITY,
  record,
  VIEW_TARGET,
  viewNode,
} from './shared.js'

interface WorkflowMemberState {
  readonly childId: SessionId
  readonly label: string
  readonly phase: string | undefined
  readonly sequence: number
  readonly status: WorkflowRunStatus
}

interface WorkflowState {
  readonly id: string
  readonly members: readonly WorkflowMemberState[]
  readonly name: string
  readonly status: WorkflowRunStatus
}

const WORKFLOW_EVENT_TYPES = new Set([
  'tool-workflow/run-start',
  'tool-workflow/agent-start',
  'tool-workflow/agent-end',
  'tool-workflow/run-end',
])

function dataOf(match: ConversationMatch): Readonly<Record<string, unknown>> | undefined {
  return record(match.event.data) ? match.event.data : undefined
}

function runIdOf(match: ConversationMatch): string | undefined {
  const runId = dataOf(match)?.runId
  return typeof runId === 'string' && runId !== '' ? runId : undefined
}

function childIdOf(value: unknown): SessionId | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  // Open workflow events carry the same opaque Session identity as the public client contract.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as SessionId
}

function outcomeStatus(value: unknown): WorkflowRunStatus | undefined {
  switch (value) {
    case 'completed': return 'completed'
    case 'cancelled': return 'cancelled'
    case 'failed': return 'failed'
    default: return undefined
  }
}

function stopStatus(value: unknown): WorkflowRunStatus | undefined {
  switch (value) {
    case 'completed': return 'completed'
    case 'cancelled': return 'cancelled'
    case 'error': return 'failed'
    default: return undefined
  }
}

function closed(location: ConversationLocation): boolean {
  if (location.kind === 'step') return location.step.status === 'closed' || location.turn.status === 'closed'
  return location.kind === 'turn' && location.turn.status === 'closed'
}

function project(state: WorkflowState, location: ConversationLocation): WorkflowPresentation {
  const interrupted = state.status === 'running' && closed(location)
  return Object.freeze({
    id: state.id,
    members: Object.freeze(state.members.map((member): WorkflowMemberPresentation => Object.freeze({
      childId: member.childId,
      label: member.label,
      phase: member.phase,
      status: interrupted && member.status === 'running' ? 'interrupted' : member.status,
    }))),
    name: state.name,
    status: interrupted ? 'interrupted' : state.status,
  })
}

function startMember(state: WorkflowState, data: Readonly<Record<string, unknown>>): WorkflowState {
  const childId = childIdOf(data.childId)
  if (childId === undefined || typeof data.seq !== 'number' || !Number.isFinite(data.seq)) return state
  const label = typeof data.label === 'string' ? data.label : ''
  const phase = typeof data.phase === 'string' ? data.phase : undefined
  const member: WorkflowMemberState = {
    childId,
    label,
    phase,
    sequence: data.seq,
    status: 'running',
  }
  return { ...state, members: [...state.members, member] }
}

function endMember(state: WorkflowState, data: Readonly<Record<string, unknown>>): WorkflowState {
  if (typeof data.seq !== 'number' || !Number.isFinite(data.seq)) return state
  const status = outcomeStatus(data.outcome)
  if (status === undefined) return state
  return {
    ...state,
    members: state.members.map(member => member.sequence === data.seq ? { ...member, status } : member),
  }
}

export const workflowDefinition: ConversationNodeDefinition<WorkflowState> = {
  kind: 'tui-workflow-run',
  target: VIEW_TARGET,
  match: (event) => {
    if (!WORKFLOW_EVENT_TYPES.has(eventType(event))) return null
    const data: unknown = event.data
    const runId = record(data) && typeof data.runId === 'string' ? data.runId : undefined
    if (runId === undefined || runId === '') return null
    return { id: runId, role: eventType(event) === 'tool-workflow/run-start' ? 'start' : 'update' }
  },
  start: (_context, match) => {
    const data = dataOf(match)
    const runId = runIdOf(match)
    if (eventType(match.event) !== 'tool-workflow/run-start'
      || data === undefined
      || runId === undefined
      || typeof data.name !== 'string') {
      throw new Error('tui workflow requires tool-workflow/run-start')
    }
    return { id: runId, members: [], name: data.name, status: 'running' }
  },
  update: (context, match) => {
    const data = dataOf(match)
    if (data === undefined) return context.state
    switch (eventType(match.event)) {
      case 'tool-workflow/agent-start': return startMember(context.state, data)
      case 'tool-workflow/agent-end': return endMember(context.state, data)
      case 'tool-workflow/run-end': {
        const status = stopStatus(data.stopReason)
        return status === undefined ? context.state : { ...context.state, status }
      }
      default: return context.state
    }
  },
  buildViewNode: (context) => {
    const state = context.state
    if (state === undefined || context.start === undefined) return null
    const workflow = project(state, context.start.location)
    const running = workflow.members.filter(member => member.status === 'running').length
    return viewNode(
      context,
      context.start.event.seq,
      `workflow:${state.id}`,
      MAIN_PRIORITY,
      'system',
      `workflow ${workflow.name} · ${workflow.status} · ${workflow.members.length} members · ${running} running`,
      undefined,
      undefined,
      workflow,
    )
  },
}
