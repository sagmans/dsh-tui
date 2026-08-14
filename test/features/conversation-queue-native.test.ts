import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createTestRenderer } from '@opentui/core/testing'
import type {
  MessageId,
  QueueAction,
  SessionId,
} from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ChatSnapshot,
  ConversationSnapshot,
  ConversationViewSnapshotStore,
  ObservableSnapshot,
} from '@deepseek-ai/dsh-client-runtime/client'
import { createConversationController } from '../../src/features/conversation/model.js'
import { createTuiTheme } from '../../src/services/theme.js'
import { createConversationView } from '../../src/views/conversation/root.js'

const NATIVE_RENDERER_AVAILABLE = process.versions.bun !== undefined
  || process.getBuiltinModule('node:ffi') !== undefined
const WIDTH = 88
const HEIGHT = 24
const SETTLE_DELAY_MS = 0
const QUEUE_ACTION_PREFIX = 'conversation-queue'
// Static fixture identities cross only Harness brand boundaries.
/* oxlint-disable typescript/no-unsafe-type-assertion */
const SESSION_ID = 'queue-native-session' as SessionId
const FIRST_ID = 'queue-native-first' as MessageId
const SECOND_ID = 'queue-native-second' as MessageId
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

function settle(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, SETTLE_DELAY_MS) })
}

function snapshot(): ConversationSnapshot {
  return {
    sessionId: SESSION_ID,
    views: EMPTY_VIEWS,
    chat: EMPTY_CHAT,
    nodes: [],
    turnTimings: new Map(),
    turnEnds: new Map(),
    partial: null,
    runningCalls: [],
    pending: [],
    queue: [
      {
        id: FIRST_ID,
        messageId: FIRST_ID,
        placement: 'queued',
        content: [{ type: 'text', text: 'First queued prompt' }],
        preview: 'First queued prompt',
        text: 'First queued prompt',
      },
      {
        id: SECOND_ID,
        messageId: SECOND_ID,
        placement: 'queued',
        content: [{ type: 'text', text: 'Second queued prompt' }],
        preview: 'Second queued prompt',
        text: 'Second queued prompt',
      },
    ],
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

test.skipIf(!NATIVE_RENDERER_AVAILABLE)('drives queue occurrence actions by keyboard and mouse', async () => {
  const harness = await createTestRenderer({ width: WIDTH, height: HEIGHT, bufferedOutput: 'memory' })
  const session = source(snapshot())
  const updates: Array<{ readonly action: QueueAction; readonly id: MessageId }> = []
  const preferenceWrites: string[] = []
  const controller = createConversationController({
    preferences: {
      read: () => Promise.resolve({ ok: true, value: { behavior: 'queue', revision: 1 } }),
      subscribe: () => () => {},
      write: (behavior, revision) => {
        preferenceWrites.push(`${behavior}:${String(revision)}`)
        return Promise.resolve({ ok: true, value: { behavior, revision: revision + 1 } })
      },
    },
    sessions: {
      list: source({ current: SESSION_ID, byId: { [SESSION_ID]: { displayTitle: 'Queue controls' } } }),
      binding: () => ({
        ...session,
        cancel: () => Promise.resolve(),
        command: () => Promise.resolve(false),
        loadOlder: () => Promise.resolve(),
        projection: () => source(undefined),
        prompt: () => Promise.resolve(),
        updateQueue: (id, action) => {
          updates.push({ action, id })
          return Promise.resolve({ ok: true, value: { accepted: true } })
        },
      }),
    },
  })
  const view = createConversationView(harness.renderer, createTuiTheme({ color: true }), controller)
  harness.renderer.root.add(view)

  try {
    await settle()
    await harness.flush()
    assert.match(harness.captureCharFrame(), /QUEUE/u)

    const busyEnter = view.findDescendantById('conversation-busy-enter')
    assert.ok(busyEnter)
    await harness.mockMouse.click(busyEnter.screenX + 1, busyEnter.screenY)
    await settle()
    const composer = view.findDescendantById('conversation-composer')
    assert.ok(composer)
    composer.focus()
    harness.mockInput.pressKey('b', { meta: true })
    await settle()
    assert.deepEqual(preferenceWrites, ['steer:1', 'queue:2'])

    const queueComposer = view.findDescendantById('conversation-composer')
    assert.ok(queueComposer)
    queueComposer.focus()
    harness.mockInput.pressKey('q', { meta: true })
    harness.mockInput.pressEnter()
    await harness.flush()
    assert.ok(view.findDescendantById('conversation-path-input'))
    harness.mockInput.pressKey('ESCAPE')
    await settle()

    const firstSteer = view.findDescendantById(`${QUEUE_ACTION_PREFIX}-steer-${String(FIRST_ID)}`)
    assert.ok(firstSteer)
    firstSteer.focus()
    harness.mockInput.pressEnter()
    await settle()

    const secondRemove = view.findDescendantById(`${QUEUE_ACTION_PREFIX}-remove-${String(SECOND_ID)}`)
    assert.ok(secondRemove)
    await harness.mockMouse.click(secondRemove.screenX + 1, secondRemove.screenY)
    await settle()

    const firstEdit = view.findDescendantById(`${QUEUE_ACTION_PREFIX}-edit-${String(FIRST_ID)}`)
    assert.ok(firstEdit)
    await harness.mockMouse.click(firstEdit.screenX + 1, firstEdit.screenY)
    await harness.flush()
    const input = view.findDescendantById('conversation-path-input')
    assert.ok(input)
    await harness.mockInput.typeText(' revised')
    const save = view.findDescendantById('conversation-path-save')
    assert.ok(save)
    await harness.mockMouse.click(save.screenX + 1, save.screenY)
    await settle()

    assert.deepEqual(updates, [
      { action: { kind: 'steer' }, id: FIRST_ID },
      { action: { kind: 'remove' }, id: SECOND_ID },
      {
        action: { kind: 'edit', content: [{ type: 'text', text: 'First queued prompt revised' }] },
        id: FIRST_ID,
      },
    ])
  } finally {
    view.destroyRecursively()
    controller.dispose()
    harness.renderer.destroy()
  }
})
