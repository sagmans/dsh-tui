import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createTestRenderer } from '@opentui/core/testing'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ChatSnapshot,
  ConversationSnapshot,
  ConversationViewSnapshotStore,
  ObservableSnapshot,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  createConversationController,
  type ConversationProjectionKey,
} from '../../src/features/conversation/model.js'
import { createTuiTheme } from '../../src/services/theme.js'
import { createConversationView } from '../../src/views/conversation/root.js'

const NATIVE_RENDERER_AVAILABLE = process.versions.bun !== undefined
  || process.getBuiltinModule('node:ffi') !== undefined
const WIDTH = 100
const HEIGHT = 28
const SETTLE_DELAY_MS = 20
const MODEL_ACTION_ID = 'conversation-model'
const ACCESS_ACTION_ID = 'conversation-access'
const PRESET_ACTION_ID = 'conversation-preset'
const STOP_ACTION_ID = 'conversation-stop'
const STATISTICS_SEAT_ID = 'conversation-information-statistics'
const CONTEXT_SEAT_ID = 'conversation-information-context'
const WORK_SEAT_ID = 'conversation-information-work'
const CONTEXT_TAB_ID = 'conversation-information-tab-context'
const WORK_TAB_ID = 'conversation-information-tab-work'
const COMPACT_ACTION_ID = 'conversation-information-compact'
const PLAN_EXIT_ACTION_ID = 'conversation-information-plan-off'
const CLOSE_ACTION_ID = 'conversation-information-close'
const COMPOSER_ID = 'conversation-composer'
const COMPACT_COMMAND = '/compact'
const PLAN_OFF_COMMAND = '/plan off'
// Static fixture identity crosses only Harness brand boundaries.
/* oxlint-disable-next-line typescript/no-unsafe-type-assertion */
const SESSION_ID = 'conversation-seats-native' as SessionId
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

function projections(): Record<ConversationProjectionKey, MutableSource<unknown>> {
  return {
    sessionStats: source({
      turns: 3,
      steps: 4,
      llmMs: 5_000,
      toolMs: 1_000,
      ttftMs: 500,
      ttftSteps: 2,
      decodeMs: 2_000,
      decodeTokens: 80,
    }),
    tokenUsage: source({
      uncachedInputTokens: 800,
      cacheReadTokens: 200,
      cacheWriteTokens: 0,
      outputTokens: 120,
    }),
    contextPressure: source({ projectedTokens: 6_000, contextWindow: 8_000 }),
    contextBreakdown: source({ systemTokens: 500, toolsTokens: 600, messageTokens: 2_000 }),
    todos: source([
      { content: 'Inspect context', status: 'completed' },
      { content: 'Verify seats', status: 'in_progress' },
    ]),
    plan: source({ active: true, pending: false }),
    goal: source({
      goal: {
        id: 'goal-native',
        revision: 1,
        objective: 'Reach capability parity',
        phase: 'active',
        maxGoalRounds: 4,
      },
      roundsStarted: 2,
      createdAt: 1,
      updatedAt: 2,
    }),
  }
}

async function invokeByKeyboard(
  view: ReturnType<typeof createConversationView>,
  harness: Awaited<ReturnType<typeof createTestRenderer>>,
  id: string,
): Promise<void> {
  const action = view.findDescendantById(id)
  assert.ok(action)
  assert.ok(action.width > 0, `${id} must remain visible`)
  action.focus()
  await harness.flush()
  assert.equal(harness.renderer.currentFocusedRenderable?.id, id)
  harness.mockInput.pressEnter()
  await settle()
  await harness.flush()
}

async function invokeByMouse(
  view: ReturnType<typeof createConversationView>,
  harness: Awaited<ReturnType<typeof createTestRenderer>>,
  id: string,
): Promise<void> {
  const action = view.findDescendantById(id)
  assert.ok(action)
  assert.ok(action.screenX < harness.renderer.width, `${id} must remain on screen`)
  await harness.mockMouse.click(action.screenX + 1, action.screenY)
  await settle()
  await harness.flush()
}

test.skipIf(!NATIVE_RENDERER_AVAILABLE)('exposes conversation information and control seats through keyboard and mouse', async () => {
  const harness = await createTestRenderer({ width: WIDTH, height: HEIGHT, bufferedOutput: 'memory' })
  const projectionFaces = projections()
  const commands: string[] = []
  const modelOpens: string[] = []
  const preferenceOpens: string[] = []
  let cancels = 0
  const controller = createConversationController({
    models: {
      getSnapshot: () => ({ available: true, currentLabel: 'DeepSeek V3', effortLabel: 'High', routable: true }),
      subscribe: () => () => {},
      open: entry => { modelOpens.push(entry); return Promise.resolve(true) },
    },
    openSettings: section => { preferenceOpens.push(section) },
    sessions: {
      list: source({
        current: SESSION_ID,
        byId: {
          [SESSION_ID]: {
            agentPreset: 'code',
            displayTitle: 'Information seats',
            projectionValues: { permissions: { currentValue: 'workspace-write' } },
          },
        },
      }),
      binding: () => ({
        ...source(snapshot()),
        cancel: () => { cancels += 1; return Promise.resolve() },
        command: (line) => { commands.push(line); return Promise.resolve(true) },
        loadOlder: () => Promise.resolve(),
        projection: key => projectionFaces[key],
        prompt: () => Promise.resolve(),
        updateQueue: () => Promise.resolve({ ok: true, value: { accepted: true } }),
      }),
    },
  })
  const view = createConversationView(harness.renderer, createTuiTheme({ color: true }), controller)
  harness.renderer.root.add(view)

  try {
    await harness.flush()
    assert.ok(view.findDescendantById(STATISTICS_SEAT_ID))
    assert.ok(view.findDescendantById(CONTEXT_SEAT_ID))
    assert.ok(view.findDescendantById(WORK_SEAT_ID))
    assert.match(harness.captureCharFrame(), /STATS.*CTX 75%.*PLAN.*GOAL.*TODO/u)

    await invokeByMouse(view, harness, MODEL_ACTION_ID)
    await invokeByKeyboard(view, harness, MODEL_ACTION_ID)
    await invokeByMouse(view, harness, ACCESS_ACTION_ID)
    await invokeByKeyboard(view, harness, ACCESS_ACTION_ID)
    await invokeByMouse(view, harness, PRESET_ACTION_ID)
    assert.deepEqual(preferenceOpens, ['access', 'access', 'presets'])
    await invokeByKeyboard(view, harness, PRESET_ACTION_ID)
    assert.deepEqual(modelOpens, ['composer', 'composer'])
    assert.deepEqual(preferenceOpens, ['access', 'access', 'presets', 'presets'])

    const composer = view.findDescendantById(COMPOSER_ID)
    assert.ok(composer)
    composer.focus()
    harness.mockInput.pressKey('i', { meta: true })
    await settle()
    await harness.flush()
    assert.match(harness.captureCharFrame(), /CONVERSATION INFO.*Turns 3.*Steps 4/su)

    await invokeByKeyboard(view, harness, CONTEXT_TAB_ID)
    assert.match(harness.captureCharFrame(), /Context used 75%.*System ~500.*Tools ~600/su)
    await invokeByMouse(view, harness, COMPACT_ACTION_ID)
    assert.deepEqual(commands, [COMPACT_COMMAND])

    await invokeByMouse(view, harness, WORK_TAB_ID)
    assert.match(harness.captureCharFrame(), /Reach capability parity.*Verify seats/su)
    await invokeByKeyboard(view, harness, PLAN_EXIT_ACTION_ID)
    assert.deepEqual(commands, [COMPACT_COMMAND, PLAN_OFF_COMMAND])

    await invokeByMouse(view, harness, CLOSE_ACTION_ID)
    assert.equal(view.findDescendantById(CLOSE_ACTION_ID), undefined)

    await invokeByMouse(view, harness, WORK_SEAT_ID)
    await invokeByKeyboard(view, harness, CLOSE_ACTION_ID)
    await invokeByKeyboard(view, harness, CONTEXT_SEAT_ID)
    await invokeByMouse(view, harness, CLOSE_ACTION_ID)
    await invokeByMouse(view, harness, STATISTICS_SEAT_ID)
    await invokeByMouse(view, harness, CLOSE_ACTION_ID)

    await invokeByMouse(view, harness, STOP_ACTION_ID)
    await invokeByKeyboard(view, harness, STOP_ACTION_ID)
    assert.equal(cancels, 2)
  } finally {
    view.destroyRecursively()
    controller.dispose()
    harness.renderer.destroy()
  }
})
