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
import { createToolsController } from '../../src/features/tools/model.js'
import { projectToolPresentation } from '../../src/features/tools/presentation.js'
import { createTuiTheme } from '../../src/services/theme.js'
import { createToolsView } from '../../src/views/tools/root.js'

const NATIVE_RENDERER_AVAILABLE = process.versions.bun !== undefined
  || process.getBuiltinModule('node:ffi') !== undefined
const WIDTH = 72
const HEIGHT = 18
const SETTLE_DELAY_MS = 0
const FIRST_PATH = '/tmp/first-output.txt'
const SECOND_PATH = '/tmp/second-output.txt'
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

function snapshot(views: ConversationViewSnapshotStore): ConversationSnapshot {
  return {
    sessionId: SESSION_ID,
    views,
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
  }
}

test.skipIf(!NATIVE_RENDERER_AVAILABLE)('selects and confirms any produced file with mouse', async () => {
  const harness = await createTestRenderer({ width: WIDTH, height: HEIGHT, bufferedOutput: 'memory' })
  const tool = projectToolPresentation({
    args: '{}',
    callId: 'write-many',
    callView: {
      card: 'diff',
      title: 'Write outputs',
      diffs: [],
      locations: [{ path: FIRST_PATH }, { path: SECOND_PATH }],
    },
    isError: false,
    name: 'write',
    result: 'done',
  })
  const views: ConversationViewSnapshotStore = {
    get: target => target === 'tui' ? { lines: [], tools: [tool], workflows: [] } : undefined,
  }
  const binding = source(snapshot(views))
  const list = source({ current: SESSION_ID, byId: { [SESSION_ID]: { displayTitle: 'Native files' } } })
  const opened: string[] = []
  const controller = createToolsController({
    openPath: (path) => { opened.push(path); return Promise.resolve() },
    sessions: { list, binding: () => binding },
  })
  const view = createToolsView(harness.renderer, createTuiTheme({ color: true }), controller)
  harness.renderer.root.add(view)

  try {
    await harness.flush()
    const second = view.findDescendantById('tool-file-1')
    assert.ok(second)
    await harness.mockMouse.click(second.screenX, second.screenY)
    await settle()
    await harness.flush()
    assert.equal(controller.getSnapshot().selectedPath, SECOND_PATH)
    assert.deepEqual(opened, [])

    const confirmation = view.findDescendantById('tool-file-1')
    assert.ok(confirmation)
    await harness.mockMouse.click(confirmation.screenX, confirmation.screenY)
    await settle()
    await harness.flush()
    assert.deepEqual(opened, [SECOND_PATH])
  } finally {
    view.destroyRecursively()
    controller.dispose()
    harness.renderer.destroy()
  }
})
