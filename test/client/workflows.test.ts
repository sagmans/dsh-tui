import assert from 'node:assert/strict'
import { test } from 'vitest'
import type {
  ConversationMatch,
  ConversationNodeContext,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import { workflowDefinition } from '../../src/client/conversation/workflows.js'

/* oxlint-disable typescript/no-unsafe-type-assertion -- Fixtures cross open Harness event boundaries. */
type Event = Parameters<ConversationNodeDefinition['match']>[0]
type WorkflowState = ReturnType<typeof workflowDefinition.start>

function match(sessionEvent: Event, role: ConversationMatch['role']): ConversationMatch {
  return { event: sessionEvent, role, view: undefined, location: { kind: 'unresolved' } }
}

function context(matches: readonly ConversationMatch[], state?: WorkflowState): ConversationNodeContext<WorkflowState> {
  return {
    key: 'workflow-run-one',
    kind: workflowDefinition.kind,
    id: 'run-one',
    matches,
    start: matches[0],
    state,
    current: new Map(),
  }
}

function updatingContext(
  matches: readonly ConversationMatch[],
  state: WorkflowState,
): ConversationNodeContext<WorkflowState> & { readonly state: WorkflowState } {
  return { ...context(matches, state), state }
}

function wireEvent(type: string, seq: number, data: Readonly<Record<string, unknown>>): Event {
  return { type, seq, time: seq, data } as unknown as Event
}

test('folds workflow phases and member outcomes into TUI metadata', () => {
  const started = match(wireEvent('tool-workflow/run-start', 1, { runId: 'run-one', name: 'Verify' }), 'start')
  const memberStarted = match(wireEvent('tool-workflow/agent-start', 2, {
    runId: 'run-one', seq: 1, label: 'Tests', phase: 'Check', childId: 'child-one',
  }), 'update')
  const memberEnded = match(wireEvent('tool-workflow/agent-end', 3, {
    runId: 'run-one', seq: 1, outcome: 'completed',
  }), 'update')
  const ended = match(wireEvent('tool-workflow/run-end', 4, { runId: 'run-one', stopReason: 'completed' }), 'update')
  const initial = workflowDefinition.start(context([started]), started, { previous: () => undefined })
  const running = workflowDefinition.update(updatingContext([started, memberStarted], initial), memberStarted)
  const memberDone = workflowDefinition.update(updatingContext([started, memberStarted, memberEnded], running), memberEnded)
  const done = workflowDefinition.update(updatingContext([started, memberStarted, memberEnded, ended], memberDone), ended)
  const node = workflowDefinition.buildViewNode?.(context([started, memberStarted, memberEnded, ended], done))

  assert.notEqual(node, null)
  const data: unknown = node?.data
  if (typeof data !== 'object' || data === null) throw new Error('missing workflow node data')
  const workflow: unknown = Reflect.get(data, 'workflow')
  if (typeof workflow !== 'object' || workflow === null) throw new Error('missing workflow metadata')
  assert.equal(Reflect.get(workflow, 'name'), 'Verify')
  assert.equal(Reflect.get(workflow, 'status'), 'completed')
  const members: unknown = Reflect.get(workflow, 'members')
  assert.equal(Array.isArray(members) ? Reflect.get(members[0] ?? {}, 'status') : undefined, 'completed')
})
/* oxlint-enable typescript/no-unsafe-type-assertion */
