import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'vitest'
import { createTestRenderer } from '@opentui/core/testing'
import type { MessageId, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ChatSnapshot,
  ConversationSnapshot,
  ConversationViewSnapshotStore,
  ObservableSnapshot,
} from '@deepseek-ai/dsh-client-runtime/client'
import { createConversationController, type ConversationSendMode } from '../../src/features/conversation/model.js'
import { createConversationView } from '../../src/views/conversation/root.js'
import { createTuiTheme } from '../../src/services/theme.js'

const NATIVE_RENDERER_AVAILABLE = process.versions.bun !== undefined
  || process.getBuiltinModule('node:ffi') !== undefined
const WIDTH = 72
const HEIGHT = 18
const SEND_ID = 'conversation-send'
const STOP_ID = 'conversation-stop'
const OLDER_ID = 'conversation-older'
const ACTION_SETTLE_DELAY_MS = 0
const STANDARD_FRAME = readFileSync(new URL('../frames/chat/standard-72x18.txt', import.meta.url), 'utf8')
// Static fixture identities cross only Harness brand boundaries.
/* oxlint-disable typescript/no-unsafe-type-assertion */
const SESSION_ID = 'session-one' as SessionId
const QUEUE_ID = 'queue-one' as MessageId
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

function settleActions(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ACTION_SETTLE_DELAY_MS) })
}

function snapshot(): ConversationSnapshot {
  return {
    sessionId: SESSION_ID,
    views: EMPTY_VIEWS,
    chat: EMPTY_CHAT,
    nodes: [{
      kind: 'user',
      seq: 1,
      time: 1,
      content: [{ type: 'text', text: 'Build terminal conversation' }],
      source: { kind: 'user' },
    }],
    turnTimings: new Map(),
    turnEnds: new Map(),
    partial: { turn: 1, step: 1, blocks: [{ kind: 'text', text: 'Working' }] },
    runningCalls: [],
    pending: [],
    queue: [{
      id: QUEUE_ID,
      messageId: QUEUE_ID,
      placement: 'queued',
      content: [{ type: 'text', text: 'Review result' }],
      preview: 'Review result',
      text: 'Review result',
    }],
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

test.skipIf(!NATIVE_RENDERER_AVAILABLE)('drives multiline composer and mouse actions in native renderer', async () => {
  const harness = await createTestRenderer({ width: WIDTH, height: HEIGHT, bufferedOutput: 'memory' })
  const session = source(snapshot())
  const prompts: Array<{ readonly mode: ConversationSendMode; readonly text: string }> = []
  let cancels = 0
  let historyLoads = 0
  const controller = createConversationController({
    completion: { complete: () => Promise.resolve(['compact', 'commit']) },
    sessions: {
      list: source({ current: SESSION_ID, byId: { [SESSION_ID]: { displayTitle: 'Terminal conversation' } } }),
      binding: () => ({
        ...session,
        cancel: () => { cancels += 1; return Promise.resolve() },
        command: () => Promise.resolve(false),
        loadOlder: () => { historyLoads += 1; return Promise.resolve() },
        prompt: (text, mode) => { prompts.push({ text, mode }); return Promise.resolve() },
      }),
    },
  })
  const view = createConversationView(harness.renderer, createTuiTheme({ color: true }), controller)
  harness.renderer.root.add(view)

  try {
    await harness.flush()
    const frame = harness.captureCharFrame()
    assert.equal(frame, STANDARD_FRAME)
    assert.match(frame, /Terminal conversation/u)
    assert.match(frame, /Build terminal conversation/u)
    assert.match(frame, /Working/u)
    assert.match(frame, /queued: Review result/u)

    await harness.mockInput.typeText('first line')
    harness.mockInput.pressEnter()
    await harness.mockInput.typeText('second line')
    harness.mockInput.pressEnter({ meta: true })
    await settleActions()
    assert.equal(controller.getSnapshot().draft, '')
    await harness.flush()
    assert.deepEqual(prompts, [{ text: 'first line\nsecond line', mode: 'queue' }])

    await harness.mockInput.typeText('/co')
    harness.mockInput.pressTab()
    await settleActions()
    await harness.waitFor(() => controller.getSnapshot().draft === '/compact ')
    await harness.flush()
    assert.match(harness.captureCharFrame(), /\/compact/u)

    const send = view.findDescendantById(SEND_ID)
    assert.ok(send)
    await harness.mockMouse.click(send.screenX, send.screenY)
    await harness.flush()
    assert.deepEqual(prompts.at(-1), { text: '/compact', mode: 'queue' })

    const stop = view.findDescendantById(STOP_ID)
    assert.ok(stop)
    await harness.mockMouse.click(stop.screenX, stop.screenY)
    await settleActions()
    await harness.flush()
    const older = view.findDescendantById(OLDER_ID)
    assert.ok(older)
    await harness.mockMouse.click(older.screenX, older.screenY)
    await harness.flush()
    assert.equal(cancels, 1)
    assert.equal(historyLoads, 1)

    harness.resize(44, 12)
    await harness.flush()
    assert.equal(harness.captureCharFrame().split('\n')[0]?.length, 44)
  } finally {
    view.destroyRecursively()
    controller.dispose()
    harness.renderer.destroy()
  }
})
