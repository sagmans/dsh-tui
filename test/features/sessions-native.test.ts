import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createTestRenderer } from '@opentui/core/testing'
import type { SessionId, WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ObservableSnapshot,
  SessionListState,
  SessionSummary,
  WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import { createNavigationStore } from '../../src/kernel/navigation.js'
import { createTuiTheme } from '../../src/services/theme.js'
import { createSessionsController } from '../../src/features/sessions/model.js'
import { createSessionsView } from '../../src/views/sessions/root.js'

const NATIVE_RENDERER_AVAILABLE = process.versions.bun !== undefined
  || process.getBuiltinModule('node:ffi') !== undefined
const WIDTH = 64
const HEIGHT = 18
const SESSION_ROW_X = 4
const SESSION_ROW_Y = 3
const SEARCH_ACTION_X = 8
const ACTION_ROW_Y = HEIGHT - 2
// Static fixture identities cross only the Harness brand boundary.
/* oxlint-disable typescript/no-unsafe-type-assertion */
const SESSION_ID = 'session-one' as SessionId
const WORKSPACE_ID = 'workspace-one' as WorkspaceId
/* oxlint-enable typescript/no-unsafe-type-assertion */

function source<T>(snapshot: T): ObservableSnapshot<T> {
  return { getSnapshot: () => snapshot, subscribe: () => () => {} }
}

function sessionState(): SessionListState {
  const summary: SessionSummary = {
    id: SESSION_ID,
    displayTitle: 'Build terminal shell',
    running: true,
    blank: false,
    updatedAt: 1,
  }
  return {
    ids: [SESSION_ID],
    byId: { [SESSION_ID]: summary },
    current: SESSION_ID,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  }
}

function workspace(): WorkspaceView {
  return {
    workspaceId: WORKSPACE_ID,
    title: 'Harness',
    path: '/work/harness',
    sessionIds: [SESSION_ID],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function workspaceState(): WorkspaceListState {
  return {
    items: [workspace()],
    archivedSessionIds: [],
    state: 'idle',
    phase: 'ready',
    error: null,
    baselinesReady: true,
    recentWorkspaceId: WORKSPACE_ID,
  }
}

test.skipIf(!NATIVE_RENDERER_AVAILABLE)('renders native session tree and opens rows with mouse', async () => {
  const harness = await createTestRenderer({ width: WIDTH, height: HEIGHT, bufferedOutput: 'memory' })
  const navigation = createNavigationStore()
  const opened: SessionId[] = []
  const controller = createSessionsController({
    navigation,
    sessions: {
      list: source(sessionState()),
      clear: () => {},
      open: id => { opened.push(id) },
      search: () => Promise.resolve({ ok: true, value: { items: [], hasMore: false } }),
      fork: () => Promise.resolve(SESSION_ID),
      loadOlder: () => Promise.resolve(),
      rename: () => Promise.resolve(),
    },
    workspaces: {
      list: source(workspaceState()),
      startSession: () => {},
      create: () => Promise.resolve(workspace()),
      rename: () => Promise.resolve(workspace()),
      delete: () => Promise.resolve(),
      insertBefore: () => Promise.resolve(),
      insertSessionBefore: () => Promise.resolve(workspace()),
      archiveSession: () => Promise.resolve(),
    },
  })
  const theme = createTuiTheme({ color: true })
  const view = createSessionsView(harness.renderer, theme, controller)
  harness.renderer.root.add(view)

  try {
    await harness.flush()
    const frame = harness.captureCharFrame()
    assert.match(frame, /WORKSPACES \/ SESSIONS/u)
    assert.match(frame, /Harness/u)
    assert.match(frame, /Build terminal shell/u)
    assert.match(frame, /running/u)

    await harness.mockMouse.scroll(SESSION_ROW_X, SESSION_ROW_Y, 'down')
    await harness.flush()

    await harness.mockMouse.click(SESSION_ROW_X, SESSION_ROW_Y)
    await harness.flush()
    assert.deepEqual(opened, [SESSION_ID])
    assert.equal(navigation.getSnapshot().route, 'chat')

    await harness.mockMouse.click(SEARCH_ACTION_X, ACTION_ROW_Y)
    await harness.flush()
    assert.match(harness.captureCharFrame(), /SEARCH SESSIONS/u)

    harness.resize(40, 10)
    await harness.flush()
    assert.equal(harness.captureCharFrame().split('\n')[0]?.length, 40)
  } finally {
    view.destroyRecursively()
    controller.dispose()
    harness.renderer.destroy()
  }
})
