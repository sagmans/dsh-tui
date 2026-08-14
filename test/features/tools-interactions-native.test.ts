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
import { createInteractionsController, type InteractionWait } from '../../src/features/interactions/model.js'
import { createToolsController } from '../../src/features/tools/model.js'
import { projectToolPresentation } from '../../src/features/tools/presentation.js'
import { createNavigationStore } from '../../src/kernel/navigation.js'
import { createTuiTheme } from '../../src/services/theme.js'
import { createInteractionsView } from '../../src/views/interactions/root.js'
import { createToolsView } from '../../src/views/tools/root.js'

const NATIVE_RENDERER_AVAILABLE = process.versions.bun !== undefined
  || process.getBuiltinModule('node:ffi') !== undefined
const WIDTH = 72
const HEIGHT = 18
const SETTLE_DELAY_MS = 0
// Static fixture identity crosses only the Harness brand boundary.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const SESSION_ID = 'session-one' as SessionId
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

function conversation(overrides: Partial<ConversationSnapshot> = {}): ConversationSnapshot {
  return {
    sessionId: SESSION_ID,
    views: { get: () => undefined },
    chat: EMPTY_CHAT,
    nodes: [],
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
    ...overrides,
  }
}

test.skipIf(!NATIVE_RENDERER_AVAILABLE)('navigates nested tool inspector with mouse', async () => {
  const harness = await createTestRenderer({ width: WIDTH, height: HEIGHT, bufferedOutput: 'memory' })
  const child = projectToolPresentation({ args: '{}', callId: 'child', isError: false, name: 'read', result: 'source' })
  const root = {
    ...projectToolPresentation({ args: '{}', callId: 'root', isError: false, name: 'run_code' }),
    children: [child],
  }
  const views: ConversationViewSnapshotStore = { get: () => ({ lines: [], tools: [root] }) }
  const binding = source(conversation({ views }))
  const list = source({ current: SESSION_ID, byId: { [SESSION_ID]: { displayTitle: 'Native tools' } } })
  const controller = createToolsController({ sessions: { list, binding: () => binding } })
  const view = createToolsView(harness.renderer, createTuiTheme({ color: true }), controller)
  harness.renderer.root.add(view)

  try {
    await harness.flush()
    assert.match(harness.captureCharFrame(), /Native tools/u)
    assert.match(harness.captureCharFrame(), /run_code/u)
    const childRow = view.findDescendantById('tool-row-child')
    assert.ok(childRow)
    await harness.mockMouse.click(childRow.screenX, childRow.screenY)
    await harness.flush()
    assert.equal(controller.getSnapshot().selectedCallId, 'child')
    assert.match(harness.captureCharFrame(), /source/u)
  } finally {
    view.destroyRecursively()
    controller.dispose()
    harness.renderer.destroy()
  }
})

test.skipIf(!NATIVE_RENDERER_AVAILABLE)('requires explicit mouse approval in native overlay', async () => {
  const harness = await createTestRenderer({ width: WIDTH, height: HEIGHT, bufferedOutput: 'memory' })
  const responses: unknown[] = []
  /* oxlint-disable typescript/no-unsafe-type-assertion -- Fixture emulates private branded Harness carrier without loading browser bundles. */
  const wait = {
    kind: 'approval',
    key: 'a:native',
    sessionId: SESSION_ID,
    payload: {
      approvalId: 'approval-native' as InteractionWait<'approval'>['payload']['approvalId'],
      toolName: 'bash',
      reason: 'Run native tests',
    },
    respond: (result: Parameters<InteractionWait<'approval'>['respond']>[0]) => {
      responses.push(result)
      return Promise.resolve({ accepted: true })
    },
  } as unknown as PendingInteraction
  /* oxlint-enable typescript/no-unsafe-type-assertion */
  const binding = source(conversation({ pending: [wait], running: true }))
  const list = source({ current: SESSION_ID, byId: { [SESSION_ID]: { displayTitle: 'Native approval' } } })
  const controller = createInteractionsController({
    navigation: createNavigationStore(),
    sessions: { list, binding: () => binding },
  })
  const view = createInteractionsView(harness.renderer, createTuiTheme({ color: true }), controller)
  harness.renderer.root.add(view)

  try {
    await harness.flush()
    const frame = harness.captureCharFrame()
    assert.match(frame, /Run native tests/u)
    assert.match(frame, /ALLOW ONCE/u)
    assert.deepEqual(responses, [])
    const approve = view.findDescendantById('interaction-approve')
    assert.ok(approve)
    await harness.mockMouse.click(approve.screenX, approve.screenY)
    await settle()
    const response: unknown = responses[0]
    if (typeof response !== 'object' || response === null) throw new Error('missing approval response')
    const value: unknown = Reflect.get(response, 'value')
    if (typeof value !== 'object' || value === null) throw new Error('missing approval value')
    assert.equal(Reflect.get(value, 'outcome'), 'allowed-once')
  } finally {
    view.destroyRecursively()
    controller.dispose()
    harness.renderer.destroy()
  }
})
