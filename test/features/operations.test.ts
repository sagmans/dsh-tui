import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { MessageId, SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { MessageFeedbackVersion } from '@deepseek-ai/dsh-message-feedback/types'
import type {
  ChatSnapshot,
  ConversationSnapshot,
  ConversationViewSnapshotStore,
  ObservableSnapshot,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  createOperationsController,
  type OperationsControllerOptions,
  type OperationsListState,
} from '../../src/features/operations/model.js'
import { createNavigationStore } from '../../src/kernel/navigation.js'

// Static identities cross Harness brand boundaries only inside fixtures.
/* oxlint-disable typescript/no-unsafe-type-assertion */
const SESSION_ID = 'session-one' as SessionId
const CHILD_ID = 'child-one' as SessionId
const MESSAGE_ID = 'message-one' as MessageId
const FEEDBACK_VERSION = 'v1' as MessageFeedbackVersion
const NEXT_FEEDBACK_VERSION = 'v2' as MessageFeedbackVersion
/* oxlint-enable typescript/no-unsafe-type-assertion */
const LARGE_TRAJECTORY_COUNT = 10_000
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

interface FixtureOptions {
  readonly feedbackDeleteConflict?: boolean
  readonly feedbackListFailure?: boolean
  readonly goalFailure?: boolean
  readonly subagentRefreshFailure?: boolean
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

function conversation(): ConversationSnapshot {
  const views: ConversationViewSnapshotStore = {
    get: target => target === 'tui'
      ? {
          lines: [],
          tools: [],
          workflows: [{
            id: 'run-one',
            name: 'Verify',
            status: 'running',
            members: [{ childId: CHILD_ID, label: 'Tests', phase: 'Check', status: 'running' }],
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
      seq: 3,
      time: 3,
      turn: 1,
      step: 1,
      messageId: MESSAGE_ID,
      blocks: [{ kind: 'text', text: 'Ready' }],
    }],
    turnTimings: new Map(),
    turnEnds: new Map(),
    partial: null,
    runningCalls: [],
    pending: [],
    queue: [],
    running: true,
    subagent: null,
    composerPhase: 'active',
    removed: false,
    openState: 'open',
    openError: null,
    hasMore: true,
    loadingOlder: false,
    promptError: null,
    blank: false,
    lastAgentError: null,
  }
}

function fixture(fixtureOptions: FixtureOptions = {}) {
  const calls: string[] = []
  const binding = source(conversation())
  const list = source<OperationsListState>({
    current: SESSION_ID,
    byId: {
      [SESSION_ID]: {
        displayTitle: 'Operations',
        running: true,
        projectionValues: {
          goal: {
            goal: { id: 'goal-one', revision: 2, objective: 'Ship safely', phase: 'active', maxGoalRounds: 5 },
            roundsStarted: 1,
          },
          plan: { active: true, pending: false },
        },
      },
      [CHILD_ID]: { displayTitle: 'Tests', running: true, origin: 'subagent', parentId: SESSION_ID },
    },
    jobsBySession: {
      [SESSION_ID]: [{ id: 'bash-1', kind: 'bash', label: 'pnpm test', status: 'running', startedAt: 1 }],
    },
    subagentsByParent: {
      [SESSION_ID]: {
        state: 'ready',
        error: null,
        parentAvailable: true,
        entries: [{ kind: 'child', id: CHILD_ID, mode: 'continuable', label: 'Tests', activity: 'running', hasChildren: false }],
      },
    },
  })
  const options: OperationsControllerOptions = {
    navigation: createNavigationStore(),
    sessions: {
      list,
      binding: () => ({
        getSnapshot: () => binding.getSnapshot(),
        subscribe: listener => binding.subscribe(listener),
        loadOlder: () => { calls.push('trajectory:older'); return Promise.resolve() },
      }),
      open: id => { calls.push(`open:${id}`) },
      openSubagent: address => { calls.push(`subagent:${address.childSessionId}`) },
      refreshSubagents: id => {
        calls.push(`refresh:${id}`)
        return fixtureOptions.subagentRefreshFailure === true
          ? Promise.reject(new Error('Subagent catalog unavailable.'))
          : Promise.resolve()
      },
    },
    actions: {
      mutateGoal: request => {
        calls.push(`goal:${request.kind}`)
        return Promise.resolve(fixtureOptions.goalFailure === true
          ? { ok: false, error: { code: 'stale-goal', message: 'Goal changed remotely.' } }
          : { ok: true, value: request.ref })
      },
      planOff: () => { calls.push('plan:off'); return Promise.resolve({ ok: true, value: undefined }) },
      listFeedback: () => fixtureOptions.feedbackListFailure === true
        ? Promise.reject(new Error('Feedback unavailable.'))
        : Promise.resolve({
            ok: true,
            value: [{
              messageId: MESSAGE_ID,
              rating: 'positive',
              note: 'Useful',
              version: FEEDBACK_VERSION,
              createdAt: 1,
              updatedAt: 1,
            }],
          }),
      putFeedback: request => {
        calls.push(`feedback:${request.rating}`)
        return Promise.resolve({
          ok: true,
          value: {
            messageId: request.messageId,
            rating: request.rating,
            ...request.note === undefined ? {} : { note: request.note },
            version: NEXT_FEEDBACK_VERSION,
            createdAt: 1,
            updatedAt: 2,
          },
        })
      },
      deleteFeedback: request => {
        calls.push(`feedback:clear:${request.messageId}`)
        return Promise.resolve(fixtureOptions.feedbackDeleteConflict === true
          ? {
              ok: false,
              error: {
                code: 'version-conflict',
                message: 'Feedback changed remotely.',
                current: {
                  messageId: MESSAGE_ID,
                  rating: 'negative',
                  version: NEXT_FEEDBACK_VERSION,
                  createdAt: 1,
                  updatedAt: 2,
                },
              },
            }
          : { ok: true, value: undefined })
      },
    },
  }
  const controller = createOperationsController(options)
  return { binding, calls, controller, list, navigation: options.navigation }
}

test('projects operational sections from shared session state', async () => {
  const { controller, navigation } = fixture()
  await controller.open()

  assert.equal(navigation.getSnapshot().overlays.at(-1)?.id, 'operations')
  assert.equal(controller.getSnapshot().section, 'goal')
  assert.match(controller.getSnapshot().rows[0]?.summary ?? '', /active/u)

  controller.selectSection('jobs')
  assert.equal(controller.getSnapshot().rows[0]?.title, 'pnpm test')
  controller.selectSection('workflows')
  assert.match(controller.getSnapshot().rows[0]?.title ?? '', /Verify/u)
  controller.selectSection('trajectory')
  assert.equal(controller.getSnapshot().rows.find(row => row.id.includes('assistant'))?.title, 'Assistant #3')
  controller.selectSection('feedback')
  assert.match(controller.getSnapshot().rows[0]?.summary ?? '', /positive/u)
})

test('drops stale binding updates after active session changes', async () => {
  const { binding, controller, list } = fixture()
  await controller.open()
  controller.selectSection('trajectory')

  list.publish({ ...list.getSnapshot(), current: undefined })
  binding.publish({ ...binding.getSnapshot(), running: false })

  assert.equal(controller.getSnapshot().rows.length, 0)
  assert.equal(controller.getSnapshot().status, 'No active session.')
})

test('surfaces host action failures without optimistic mutation', async () => {
  const { controller } = fixture({ goalFailure: true })
  await controller.open()

  assert.equal(await controller.perform('goal.pause'), false)
  assert.match(controller.getSnapshot().error ?? '', /Goal changed remotely/u)
  assert.match(controller.getSnapshot().rows[0]?.summary ?? '', /active/u)
})

test('reconciles feedback clear conflicts from authoritative host state', async () => {
  const { controller } = fixture({ feedbackDeleteConflict: true })
  await controller.open()
  controller.selectSection('feedback')

  assert.equal(await controller.perform('feedback.clear'), false)
  assert.equal(await controller.perform('feedback.clear'), false)
  assert.match(controller.getSnapshot().error ?? '', /Feedback changed remotely/u)
  assert.match(controller.getSnapshot().rows[0]?.summary ?? '', /negative/u)
})

test('contains operational refresh failures inside the overlay', async () => {
  const { controller } = fixture({ feedbackListFailure: true, subagentRefreshFailure: true })

  await controller.open()

  assert.match(controller.getSnapshot().error ?? '', /unavailable/u)
  assert.equal(controller.getSnapshot().busy, false)
})

test('projects large trajectory snapshots without dropping events', () => {
  const { binding, controller } = fixture()
  const nodes: ConversationSnapshot['nodes'] = Array.from({ length: LARGE_TRAJECTORY_COUNT }, (_, index) => ({
    kind: 'assistant',
    seq: index + 1,
    time: index + 1,
    turn: index + 1,
    step: 1,
    blocks: [{ kind: 'text', text: `event ${index + 1}` }],
  }))
  binding.publish({ ...binding.getSnapshot(), nodes })
  controller.selectSection('trajectory')

  assert.equal(controller.getSnapshot().rows.length, LARGE_TRAJECTORY_COUNT + 1)
  assert.equal(controller.getSnapshot().rows.at(-1)?.title, `Assistant #${LARGE_TRAJECTORY_COUNT}`)
})

test('cycles every enabled operation action and runs the selected action', async () => {
  const { calls, controller } = fixture()
  await controller.open()

  assert.equal(controller.getSnapshot().selectedActionId, 'goal.pause')
  controller.moveAction(1)
  assert.equal(controller.getSnapshot().selectedActionId, 'goal.edit')
  assert.equal(await controller.perform(), true)
  assert.equal(controller.getSnapshot().input?.kind, 'goal-edit')
  controller.cancelInput()
  controller.moveAction(-1)
  assert.equal(controller.getSnapshot().selectedActionId, 'goal.pause')

  assert.deepEqual(calls.filter(call => !call.startsWith('refresh:')), [])
})

test('routes explicit actions and confirms destructive goal clearing', async () => {
  const { calls, controller } = fixture()
  await controller.open()

  assert.equal(await controller.perform('goal.edit'), true)
  controller.setInput('Ship with proof')
  assert.equal(await controller.submitInput(), true)
  assert.equal(controller.getSnapshot().input, undefined)
  assert.equal(await controller.perform('goal.pause'), true)
  assert.equal(await controller.perform('goal.clear'), false)
  assert.equal(controller.getSnapshot().confirmation, 'goal.clear')
  assert.equal(await controller.perform('goal.clear'), true)

  controller.selectSection('subagents')
  assert.equal(await controller.perform('subagent.open'), true)
  controller.selectSection('feedback')
  assert.equal(await controller.perform('feedback.negative'), true)

  assert.deepEqual(calls.filter(call => !call.startsWith('refresh:')), [
    'goal:edit',
    'goal:pause',
    'goal:clear',
    `subagent:${CHILD_ID}`,
    'feedback:negative',
  ])
})
