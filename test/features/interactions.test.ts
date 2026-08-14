import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ChatSnapshot,
  ConversationSnapshot,
  ConversationViewSnapshotStore,
  ObservableSnapshot,
  PendingInteraction,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  createInteractionsController,
  type InteractionWait,
} from '../../src/features/interactions/model.js'
import { createNavigationStore } from '../../src/kernel/navigation.js'

// Static fixture identities cross only Harness brand boundaries.
/* oxlint-disable typescript/no-unsafe-type-assertion */
const SESSION_ID = 'session-one' as SessionId
const APPROVAL_ID = 'approval-one' as InteractionWait<'approval'>['payload']['approvalId']
const APPROVAL_KEY = 'a:rpc-approval'
const QUESTION_KEY = 'q:rpc-question'
/* oxlint-enable typescript/no-unsafe-type-assertion */

const EMPTY_VIEWS: ConversationViewSnapshotStore = { get: () => undefined }
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

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null
}

function answerRows(response: unknown): readonly unknown[] {
  if (!record(response) || !record(response.value) || !record(response.value.answer)) return []
  return Array.isArray(response.value.answer.answers) ? response.value.answer.answers : []
}

function snapshot(pending: readonly PendingInteraction[]): ConversationSnapshot {
  return {
    sessionId: SESSION_ID,
    views: EMPTY_VIEWS,
    chat: EMPTY_CHAT,
    nodes: [],
    turnTimings: new Map(),
    turnEnds: new Map(),
    partial: null,
    runningCalls: [],
    pending,
    queue: [],
    running: true,
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

function fixture(pending: readonly PendingInteraction[]) {
  const responses: unknown[] = []
  const session = source(snapshot(pending))
  const list = source<{
    readonly current: SessionId | undefined
    readonly byId: Readonly<Record<SessionId, { readonly displayTitle: string } | undefined>>
  }>({ current: SESSION_ID, byId: { [SESSION_ID]: { displayTitle: 'Interaction session' } } })
  const navigation = createNavigationStore()
  const controller = createInteractionsController({
    navigation,
    sessions: { list, binding: () => session },
  })
  return { controller, list, navigation, responses, session }
}

/* oxlint-disable typescript/no-unsafe-type-assertion -- Fixtures emulate private branded Harness carriers without loading browser bundles. */
function interaction<K extends InteractionWait['kind']>(
  wait: Omit<InteractionWait<K>, 'respond'>,
  responses: unknown[],
): PendingInteraction {
  return {
    ...wait,
    respond: (result: Parameters<InteractionWait<K>['respond']>[0]) => {
      responses.push(result)
      return Promise.resolve({ accepted: true })
    },
  } as unknown as PendingInteraction
}

function approval(responses: unknown[]): PendingInteraction {
  return interaction({
    kind: 'approval',
    key: APPROVAL_KEY,
    sessionId: SESSION_ID,
    payload: {
      approvalId: APPROVAL_ID,
      toolName: 'bash',
      callId: 'call-one' as NonNullable<InteractionWait<'approval'>['payload']['callId']>,
      reason: 'Run project tests',
    },
  }, responses)
}

function question(responses: unknown[]): PendingInteraction {
  return interaction({
    kind: 'question',
    key: QUESTION_KEY,
    sessionId: SESSION_ID,
    payload: {
      questions: [
        {
          id: 'target',
          question: 'Choose targets',
          options: [{ label: 'Unit' }, { label: 'Integration' }],
          multiSelect: true,
        },
        { id: 'note', question: 'Add context?' },
      ],
    },
  }, responses)
}
/* oxlint-enable typescript/no-unsafe-type-assertion */

test('opens approval overlay and grants only through explicit approval', async () => {
  const responses: unknown[] = []
  const wait = approval(responses)
  const { controller, navigation, session } = fixture([wait])

  assert.equal(controller.getSnapshot().kind, 'approval')
  assert.equal(controller.getSnapshot().canReject, true)
  assert.equal(navigation.getSnapshot().overlays.at(-1)?.id, `interaction:${wait.key}`)
  assert.equal(await controller.approve(), true)
  assert.equal(await controller.approve(), false)
  assert.deepEqual(responses, [{
    ok: true,
    value: { sessionId: SESSION_ID, approvalId: APPROVAL_ID, outcome: 'allowed-once' },
  }])

  session.publish(snapshot([]))
  assert.equal(navigation.getSnapshot().overlays.length, 0)
})

test('answers complete multi-question batches and preserves exact option labels', async () => {
  const responses: unknown[] = []
  const wait = question(responses)
  const { controller } = fixture([wait])

  assert.equal(controller.getSnapshot().kind, 'question')
  controller.chooseOption(0)
  controller.chooseOption(1)
  controller.nextQuestion()
  controller.setCustom('Use disposable fixtures')
  assert.equal(await controller.submit(), true)
  assert.deepEqual(responses, [{
    ok: true,
    value: {
      sessionId: SESSION_ID,
      answer: {
        answers: [
          { id: 'target', selected: ['Unit', 'Integration'] },
          { id: 'note', selected: [], custom: 'Use disposable fixtures' },
        ],
      },
    },
  }])
})

test('routes strict plan reviews and malformed requests through fail-closed actions', async () => {
  const responses: unknown[] = []
  const review = interaction({
    kind: 'question',
    key: QUESTION_KEY,
    sessionId: SESSION_ID,
    payload: {
      questions: [{
        id: 'plan',
        question: 'Proceed?',
        detail: '# Safe plan',
        options: [{ label: 'Reject' }, { label: 'Approve' }],
        intent: { kind: 'plan-review', approve: 'Approve' },
      }],
    },
  }, responses)
  const reviewFixture = fixture([review])
  assert.equal(reviewFixture.controller.getSnapshot().kind, 'plan-review')
  assert.equal(reviewFixture.controller.getSnapshot().canReject, true)
  assert.equal(await reviewFixture.controller.reject(), true)
  assert.deepEqual(answerRows(responses[0]), [{ id: 'plan', selected: ['Reject'] }])

  const malformedResponses: unknown[] = []
  const malformed = interaction({
    kind: 'question',
    key: 'q:rpc-malformed',
    sessionId: SESSION_ID,
    payload: { questions: [] },
  }, malformedResponses)
  const malformedFixture = fixture([malformed])
  assert.equal(malformedFixture.controller.getSnapshot().kind, 'unavailable')
  assert.equal(await malformedFixture.controller.approve(), false)
  assert.equal(await malformedFixture.controller.cancel(), true)
  assert.equal(record(malformedResponses[0]) ? malformedResponses[0].ok : undefined, false)
})

test('does not offer rejection when a plan review has no decline option', async () => {
  const responses: unknown[] = []
  const review = interaction({
    kind: 'question',
    key: QUESTION_KEY,
    sessionId: SESSION_ID,
    payload: {
      questions: [{
        id: 'plan',
        question: 'Proceed?',
        detail: '# Safe plan',
        options: [{ label: 'Approve' }],
        intent: { kind: 'plan-review', approve: 'Approve' },
      }],
    },
  }, responses)
  const { controller } = fixture([review])

  assert.equal(controller.getSnapshot().kind, 'plan-review')
  assert.equal(controller.getSnapshot().canReject, false)
  assert.equal(await controller.reject(), false)
  assert.deepEqual(responses, [])
})

test('removes its overlay by identity during session switches and disposal', () => {
  const responses: unknown[] = []
  const wait = approval(responses)
  const { controller, list, navigation } = fixture([wait])
  navigation.openOverlay({ id: 'help' })

  list.publish({ current: undefined, byId: {} })
  assert.deepEqual(navigation.getSnapshot().overlays.map(overlay => overlay.id), ['help'])

  controller.dispose()
  assert.deepEqual(navigation.getSnapshot().overlays.map(overlay => overlay.id), ['help'])
})
