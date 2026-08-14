import assert from 'node:assert/strict'
import { test } from 'vitest'
import type {
  MessageId,
  SessionId,
} from '@deepseek-ai/dsh-client-connection/client'
import type { MessageFeedbackVersion } from '@deepseek-ai/dsh-message-feedback/types'
import type {
  ChatSnapshot,
  ConversationSnapshot,
  ConversationViewSnapshotStore,
  ObservableSnapshot,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  createOperationsController,
  type GoalMutationRequest,
  type OperationsControllerOptions,
  type OperationsListState,
} from '../../src/features/operations/model.js'
import { createNavigationStore } from '../../src/kernel/navigation.js'

// Static fixture identities cross only Harness brand boundaries.
/* oxlint-disable typescript/no-unsafe-type-assertion */
const SESSION_ID = 'session-operations-parity' as SessionId
const CHILD_ID = 'child-running' as SessionId
const SETTLED_CHILD_ID = 'child-settled' as SessionId
const MESSAGE_ID = 'message-final' as MessageId
/* oxlint-enable typescript/no-unsafe-type-assertion */
const GOAL_ID = 'goal-parity'
const EMPTY_CHAT: ChatSnapshot = {
  order: [],
  nodes: { get: () => undefined, values: () => [] },
  locations: { getTurn: () => [], getStep: () => [] },
  timeline: { turnOrder: [], turns: new Map() },
  legacy: { nodes: [], turnTimings: new Map(), turnEnds: new Map(), partial: null, runningCalls: [] },
}

interface MutableSource<T> extends ObservableSnapshot<T> {
  publish(next: T): void
}

function source<T>(initial: T): MutableSource<T> {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => current,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    publish(next) {
      current = next
      for (const listener of listeners) listener()
    },
  }
}

function feedbackVersion(value: string): MessageFeedbackVersion {
  // Test versions cross only the feedback brand boundary.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as MessageFeedbackVersion
}

function conversation(): ConversationSnapshot {
  const views: ConversationViewSnapshotStore = {
    get: target => target === 'tui'
      ? {
          lines: [],
          tools: [],
          workflows: [{
            id: 'workflow-one',
            name: 'Release checks',
            status: 'running',
            members: [
              { childId: CHILD_ID, label: 'Live checks', phase: 'Verify', status: 'running' },
              { childId: SETTLED_CHILD_ID, label: 'Finished checks', phase: 'Verify', status: 'completed' },
            ],
          }],
        }
      : undefined,
  }
  return {
    sessionId: SESSION_ID,
    views,
    chat: EMPTY_CHAT,
    nodes: [{
      kind: 'assistant',
      seq: 4,
      time: 4,
      turn: 1,
      step: 2,
      messageId: MESSAGE_ID,
      blocks: [{ kind: 'text', text: 'Ready to ship' }],
    }],
    turnTimings: new Map(),
    turnEnds: new Map(),
    partial: null,
    runningCalls: [],
    pending: [],
    queue: [],
    running: false,
    subagent: null,
    composerPhase: 'active',
    removed: false,
    openState: 'open',
    openError: null,
    hasMore: false,
    loadingOlder: false,
    promptError: null,
    blank: false,
    lastAgentError: null,
  }
}

function goalProjection(phase: 'active' | 'blocked' | 'complete' | 'paused', revision: number) {
  return {
    goal: {
      id: GOAL_ID,
      revision,
      objective: 'Ship with proof',
      phase,
      maxGoalRounds: 4,
    },
    roundsStarted: 2,
  }
}

function fixture() {
  const calls: Array<
    | { readonly kind: 'feedback-delete'; readonly version: MessageFeedbackVersion }
    | { readonly ifVersion: MessageFeedbackVersion | null; readonly kind: 'feedback-put'; readonly note?: string; readonly rating: string }
    | { readonly kind: 'goal'; readonly request: GoalMutationRequest }
    | { readonly kind: 'open'; readonly sessionId: SessionId }
    | { readonly kind: 'plan-off' }
  > = []
  const binding = source(conversation())
  const list = source<OperationsListState>({
    current: SESSION_ID,
    byId: {
      [SESSION_ID]: {
        displayTitle: 'Parity operations',
        running: false,
        projectionValues: {
          goal: goalProjection('active', 2),
          plan: { active: true, pending: false },
        },
      },
      [CHILD_ID]: {
        displayTitle: 'Live checks',
        origin: 'subagent',
        parentId: SESSION_ID,
        running: true,
      },
      [SETTLED_CHILD_ID]: {
        displayTitle: 'Finished checks',
        origin: 'subagent',
        parentId: SESSION_ID,
        running: false,
      },
    },
    jobsBySession: {
      [SESSION_ID]: [
        { id: 'done', kind: 'bash', label: 'Done job', status: 'completed', startedAt: 1, finishedAt: 10 },
        { id: 'live', kind: 'workflow', label: 'Live job', status: 'running', startedAt: 2, detail: 'Checking' },
      ],
    },
    subagentsByParent: {},
  })
  let feedbackRevision = 0
  const options: OperationsControllerOptions = {
    navigation: createNavigationStore(),
    openTrajectory: () => {},
    sessions: {
      list,
      binding: () => ({
        getSnapshot: () => binding.getSnapshot(),
        subscribe: listener => binding.subscribe(listener),
        loadOlder: () => Promise.resolve(),
      }),
      open: sessionId => { calls.push({ kind: 'open', sessionId }) },
      openSubagent: () => {},
      refreshSubagents: () => Promise.resolve(),
    },
    actions: {
      listFeedback: () => Promise.resolve({ ok: true, value: [] }),
      mutateGoal: request => {
        calls.push({ kind: 'goal', request })
        return Promise.resolve({ ok: true, value: request.ref })
      },
      planOff: () => {
        calls.push({ kind: 'plan-off' })
        return Promise.resolve({ ok: true, value: undefined })
      },
      putFeedback: request => {
        calls.push({
          kind: 'feedback-put',
          ifVersion: request.ifVersion,
          rating: request.rating,
          ...request.note === undefined ? {} : { note: request.note },
        })
        feedbackRevision++
        return Promise.resolve({
          ok: true,
          value: {
            messageId: request.messageId,
            rating: request.rating,
            ...request.note === undefined ? {} : { note: request.note },
            version: feedbackVersion(`v${String(feedbackRevision)}`),
            createdAt: 1,
            updatedAt: feedbackRevision + 1,
          },
        })
      },
      deleteFeedback: request => {
        calls.push({ kind: 'feedback-delete', version: request.version })
        return Promise.resolve({ ok: true, value: undefined })
      },
    },
  }
  const controller = createOperationsController(options)
  const publishGoal = (phase: 'active' | 'blocked' | 'complete' | 'paused', revision: number): void => {
    const current = list.getSnapshot()
    const summary = current.byId[SESSION_ID]
    assert.ok(summary)
    list.publish({
      ...current,
      byId: {
        ...current.byId,
        [SESSION_ID]: {
          ...summary,
          projectionValues: {
            ...summary.projectionValues,
            goal: goalProjection(phase, revision),
          },
        },
      },
    })
  }
  return { calls, controller, list, navigation: options.navigation, publishGoal }
}

function goalCalls(calls: ReturnType<typeof fixture>['calls']): readonly GoalMutationRequest[] {
  return calls.flatMap(call => call.kind === 'goal' ? [call.request] : [])
}

test('completes goal mutation lifecycle with current CAS refs and suppresses a cleared goal', async () => {
  const { calls, controller, publishGoal } = fixture()
  await controller.open()

  assert.equal(await controller.perform('goal.edit'), true)
  controller.setInput('Ship safely with proof')
  assert.equal(await controller.submitInput(), true)
  assert.equal(await controller.perform('goal.pause'), true)

  publishGoal('paused', 3)
  assert.equal(await controller.perform('goal.resume'), true)
  assert.equal(await controller.perform('goal.complete'), true)
  assert.equal(await controller.perform('goal.clear'), false)
  assert.equal(controller.getSnapshot().confirmation, 'goal.clear')
  assert.equal(await controller.perform('goal.clear'), true)

  const mutations = goalCalls(calls)
  assert.deepEqual(mutations.map(request => ({
    kind: request.kind,
    objective: request.objective,
    revision: request.ref.revision,
  })), [
    { kind: 'edit', objective: 'Ship safely with proof', revision: 2 },
    { kind: 'pause', objective: undefined, revision: 2 },
    { kind: 'resume', objective: undefined, revision: 3 },
    { kind: 'complete', objective: undefined, revision: 3 },
    { kind: 'clear', objective: undefined, revision: 3 },
  ])
  assert.equal(controller.getSnapshot().rows.length, 0)
})

test('keeps jobs read-only and opens only an authorized live workflow member', async () => {
  const { calls, controller, navigation } = fixture()
  await controller.open()

  controller.selectSection('jobs')
  const jobs = controller.getSnapshot()
  assert.deepEqual(jobs.rows.map(row => row.title), ['Live job', 'Done job'])
  assert.deepEqual(jobs.rows.map(row => row.actions), [[], []])
  assert.match(jobs.status, /read only/u)

  controller.selectSection('plan')
  assert.equal(await controller.perform('plan.off'), true)
  controller.selectSection('workflows')
  assert.equal(controller.getSnapshot().rows.length, 2)
  controller.selectRow(1)
  assert.equal(await controller.perform('workflow.open'), false)
  controller.selectRow(0)
  assert.equal(await controller.perform('workflow.open'), true)

  assert.deepEqual(calls.filter(call => call.kind === 'plan-off' || call.kind === 'open'), [
    { kind: 'plan-off' },
    { kind: 'open', sessionId: CHILD_ID },
  ])
  assert.equal(navigation.getSnapshot().overlays.length, 0)
})

test('creates, switches, annotates, and explicitly clears per-message feedback', async () => {
  const { calls, controller } = fixture()
  await controller.open()
  controller.selectSection('feedback')

  assert.match(controller.getSnapshot().rows[0]?.summary ?? '', /not rated/u)
  assert.equal(await controller.perform('feedback.positive'), true)
  assert.equal(await controller.perform('feedback.negative'), true)
  assert.equal(await controller.perform('feedback.note'), true)
  controller.setInput('Needs a stronger source')
  assert.equal(await controller.submitInput(), true)
  assert.match(controller.getSnapshot().rows[0]?.summary ?? '', /negative · note/u)

  assert.equal(await controller.perform('feedback.clear'), false)
  assert.equal(controller.getSnapshot().confirmation, 'feedback.clear')
  assert.equal(await controller.perform('feedback.clear'), true)
  assert.match(controller.getSnapshot().rows[0]?.summary ?? '', /not rated/u)

  assert.deepEqual(calls.filter(call => call.kind.startsWith('feedback-')), [
    { kind: 'feedback-put', ifVersion: null, rating: 'positive' },
    { kind: 'feedback-put', ifVersion: feedbackVersion('v1'), rating: 'negative' },
    {
      kind: 'feedback-put',
      ifVersion: feedbackVersion('v2'),
      rating: 'negative',
      note: 'Needs a stronger source',
    },
    { kind: 'feedback-delete', version: feedbackVersion('v3') },
  ])
})

test('binds destructive confirmation to the exact action and current target revision', async () => {
  const { controller, publishGoal } = fixture()
  await controller.open()

  assert.equal(await controller.perform('goal.clear'), false)
  publishGoal('active', 3)
  assert.equal(controller.getSnapshot().confirmation, undefined)
  assert.equal(await controller.perform('goal.clear'), false)
  assert.equal(controller.getSnapshot().confirmation, 'goal.clear')
})
