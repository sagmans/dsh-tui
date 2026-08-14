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
import { createSessionsController } from '../../src/features/sessions/model.js'
import { createNavigationStore } from '../../src/kernel/navigation.js'
import { createTuiTheme } from '../../src/services/theme.js'
import { createSessionsView } from '../../src/views/sessions/root.js'

const NATIVE_RENDERER_AVAILABLE = process.versions.bun !== undefined
  || process.getBuiltinModule('node:ffi') !== undefined
const WIDTH = 72
const HEIGHT = 18
const GROUP_ACTION_ID = 'sessions-group-mode'
const ORDER_ACTION_ID = 'sessions-order-mode'
const UNREAD_ACTION_ID = 'sessions-unread'
const SETTLE_DELAY_MS = 0
// Static fixture identities cross only Harness brand boundaries.
/* oxlint-disable typescript/no-unsafe-type-assertion */
const READ_SESSION = 'session-read' as SessionId
const UNREAD_SESSION = 'session-unread' as SessionId
const WORKSPACE_ID = 'workspace-main' as WorkspaceId
/* oxlint-enable typescript/no-unsafe-type-assertion */

function source<T>(snapshot: T): ObservableSnapshot<T> {
  return { getSnapshot: () => snapshot, subscribe: () => () => {} }
}

function summary(id: SessionId, title: string, updatedAt: number, completed = false): SessionSummary {
  return {
    id,
    displayTitle: title,
    running: false,
    blank: false,
    updatedAt,
    ...completed ? { completed: true } : {},
  }
}

function sessionsState(): SessionListState {
  return {
    ids: [READ_SESSION, UNREAD_SESSION],
    byId: {
      [READ_SESSION]: summary(READ_SESSION, 'Read session', 10),
      [UNREAD_SESSION]: summary(UNREAD_SESSION, 'Unread session', 20, true),
    },
    current: READ_SESSION,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  }
}

function workspace(): WorkspaceView {
  return {
    workspaceId: WORKSPACE_ID,
    title: 'Workspace',
    path: '/work/main',
    sessionIds: [READ_SESSION, UNREAD_SESSION],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function workspacesState(): WorkspaceListState {
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

function settle(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, SETTLE_DELAY_MS) })
}

async function invokeByKeyboard(
  view: ReturnType<typeof createSessionsView>,
  harness: Awaited<ReturnType<typeof createTestRenderer>>,
  id: string,
): Promise<void> {
  const action = view.findDescendantById(id)
  assert.ok(action)
  action.focus()
  harness.mockInput.pressEnter()
  await settle()
  await harness.flush()
}

async function invokeByMouse(
  view: ReturnType<typeof createSessionsView>,
  harness: Awaited<ReturnType<typeof createTestRenderer>>,
  id: string,
): Promise<void> {
  const action = view.findDescendantById(id)
  assert.ok(action)
  await harness.mockMouse.click(action.screenX + 1, action.screenY)
  await settle()
  await harness.flush()
}

function controller(): ReturnType<typeof createSessionsController> {
  return createSessionsController({
    navigation: createNavigationStore(),
    sessions: {
      list: source(sessionsState()),
      clear: () => {},
      open: () => {},
      search: () => Promise.resolve({ ok: true, value: { items: [], hasMore: false } }),
      fork: () => Promise.resolve(READ_SESSION),
      loadOlder: () => Promise.resolve(),
      rename: () => Promise.resolve(),
    },
    workspaces: {
      list: source(workspacesState()),
      startSession: () => {},
      create: () => Promise.resolve(workspace()),
      rename: () => Promise.resolve(workspace()),
      delete: () => Promise.resolve(),
      insertBefore: () => Promise.resolve(),
      insertSessionBefore: () => Promise.resolve(workspace()),
      archiveSession: () => Promise.resolve(),
    },
  })
}

test.skipIf(!NATIVE_RENDERER_AVAILABLE)('controls session grouping, sorting, and unread traversal by mouse and keyboard', async () => {
  const harness = await createTestRenderer({ width: WIDTH, height: HEIGHT, bufferedOutput: 'memory' })
  const sessionsController = controller()
  const view = createSessionsView(harness.renderer, createTuiTheme({ color: true }), sessionsController)
  harness.renderer.root.add(view)

  try {
    await harness.flush()
    assert.match(harness.captureCharFrame(), /GROUP WORKSPACE.*SORT UPDATED.*UNREAD 1/u)

    await invokeByMouse(view, harness, GROUP_ACTION_ID)
    assert.equal(sessionsController.getSnapshot().groupMode, 'flat')
    assert.equal(sessionsController.getSnapshot().rows.some(row => row.kind === 'workspace'), false)

    await invokeByKeyboard(view, harness, GROUP_ACTION_ID)
    assert.equal(sessionsController.getSnapshot().groupMode, 'workspace')

    await invokeByKeyboard(view, harness, ORDER_ACTION_ID)
    assert.equal(sessionsController.getSnapshot().orderMode, 'manual')
    await invokeByMouse(view, harness, ORDER_ACTION_ID)
    assert.equal(sessionsController.getSnapshot().orderMode, 'updated')

    await invokeByKeyboard(view, harness, UNREAD_ACTION_ID)
    assert.equal(sessionsController.getSnapshot().activeRowKey, `session:${UNREAD_SESSION}`)
    await invokeByMouse(view, harness, UNREAD_ACTION_ID)
    assert.equal(sessionsController.getSnapshot().activeRowKey, `session:${UNREAD_SESSION}`)
  } finally {
    view.destroyRecursively()
    sessionsController.dispose()
    harness.renderer.destroy()
  }
})
