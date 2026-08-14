import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createTestRenderer } from '@opentui/core/testing'
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
import { createTuiTheme } from '../../src/services/theme.js'
import { createInteractionsView } from '../../src/views/interactions/root.js'

const NATIVE_RENDERER_AVAILABLE = process.versions.bun !== undefined
  || process.getBuiltinModule('node:ffi') !== undefined
const WIDTH = 80
const HEIGHT = 24
const SETTLE_DELAY_MS = 0
// Static fixture identity crosses only the Harness brand boundary.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const SESSION_ID = 'session-interactions-native' as SessionId
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

function conversation(pending: readonly PendingInteraction[]): ConversationSnapshot {
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

function fixture(wait: PendingInteraction) {
  const binding = source(conversation([wait]))
  const list = source({ current: SESSION_ID, byId: { [SESSION_ID]: { displayTitle: 'Questions' } } })
  const controller = createInteractionsController({
    navigation: createNavigationStore(),
    sessions: { list, binding: () => binding },
  })
  return { binding, controller }
}

function question(responses: unknown[]): PendingInteraction {
  /* oxlint-disable typescript/no-unsafe-type-assertion -- Fixture emulates the private branded Harness carrier. */
  return {
    kind: 'question',
    key: 'q:native-question',
    sessionId: SESSION_ID,
    payload: {
      questions: [
        {
          id: 'mode',
          header: 'Runtime',
          question: 'Choose mode',
          options: [
            { label: 'Fast (Recommended)', description: 'Best default' },
            { label: 'Safe' },
          ],
        },
        { id: 'note', question: 'Add context?' },
      ],
    },
    respond: (result: Parameters<InteractionWait<'question'>['respond']>[0]) => {
      responses.push(result)
      return Promise.resolve({ accepted: true })
    },
  } as unknown as PendingInteraction
  /* oxlint-enable typescript/no-unsafe-type-assertion */
}

test.skipIf(!NATIVE_RENDERER_AVAILABLE)('completes recommended option and custom-answer flow with mouse and keyboard', async () => {
  const harness = await createTestRenderer({ width: WIDTH, height: HEIGHT, bufferedOutput: 'memory' })
  const responses: unknown[] = []
  const { controller } = fixture(question(responses))
  const view = createInteractionsView(harness.renderer, createTuiTheme({ color: true }), controller)
  harness.renderer.root.add(view)

  try {
    await harness.flush()
    const initial = harness.captureCharFrame()
    assert.match(initial, /Runtime · Choose mode/u)
    assert.match(initial, /Fast · RECOMMENDED · Best default/u)

    const recommended = view.findDescendantById('interaction-option-0')
    assert.ok(recommended)
    await harness.mockMouse.click(recommended.screenX + 1, recommended.screenY)
    await settle()
    await harness.flush()
    assert.equal(controller.getSnapshot().questionIndex, 1)

    const custom = view.findDescendantById('interaction-custom')
    assert.ok(custom)
    await harness.mockMouse.click(custom.screenX + 1, custom.screenY)
    await harness.mockInput.typeText('Use disposable fixtures')
    await settle()
    await harness.flush()
    assert.equal(harness.renderer.currentFocusedEditor?.id, 'interaction-custom')

    const submit = view.findDescendantById('interaction-submit')
    assert.ok(submit)
    assert.equal(submit.focusable, true)
    harness.mockInput.pressTab()
    harness.mockInput.pressEnter()
    await settle()
    await harness.flush()

    assert.deepEqual(responses, [{
      ok: true,
      value: {
        sessionId: SESSION_ID,
        answer: {
          answers: [
            { id: 'mode', selected: ['Fast (Recommended)'] },
            { id: 'note', selected: [], custom: 'Use disposable fixtures' },
          ],
        },
      },
    }])
    const settledCustom = view.findDescendantById('interaction-custom')
    assert.ok(settledCustom)
    assert.equal(settledCustom.focusable, false)
  } finally {
    view.destroyRecursively()
    controller.dispose()
    harness.renderer.destroy()
  }
})

test.skipIf(!NATIVE_RENDERER_AVAILABLE)('cancels a focused custom-answer flow through its mouse action', async () => {
  const harness = await createTestRenderer({ width: WIDTH, height: HEIGHT, bufferedOutput: 'memory' })
  const responses: unknown[] = []
  const { controller } = fixture(question(responses))
  const view = createInteractionsView(harness.renderer, createTuiTheme({ color: true }), controller)
  harness.renderer.root.add(view)

  try {
    await harness.flush()
    const custom = view.findDescendantById('interaction-custom')
    assert.ok(custom)
    await harness.mockMouse.click(custom.screenX + 1, custom.screenY)
    const cancel = view.findDescendantById('interaction-cancel')
    assert.ok(cancel)
    assert.equal(cancel.focusable, true)
    await harness.mockMouse.click(cancel.screenX + 1, cancel.screenY)
    await settle()

    assert.deepEqual(responses, [{
      ok: false,
      error: { code: 'cancelled', message: 'the user closed this question request', details: {} },
    }])
  } finally {
    view.destroyRecursively()
    controller.dispose()
    harness.renderer.destroy()
  }
})
