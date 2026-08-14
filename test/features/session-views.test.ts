import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { SessionId, WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ObservableSnapshot,
  SessionListState,
  SessionSummary,
  WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import { createNavigationStore } from '../../src/kernel/navigation.js'
import {
  createSessionsController,
  normalizeSessionSearchQuery,
  type SessionsControllerOptions,
} from '../../src/features/sessions/model.js'
import {
  projectSearch,
  SESSION_SEARCH_RESULT_LIMIT,
} from '../../src/features/sessions/projection.js'

const SEARCH_QUERY_LIMIT = 500
const LOCAL_SEARCH_RESULT_COUNT = SESSION_SEARCH_RESULT_LIMIT + 1
const REMOTE_SNIPPET = 'remote content match'
const TRAILING_TEXT = 'tail'
// Static fixture identities cross only Harness brand boundaries.
/* oxlint-disable typescript/no-unsafe-type-assertion */
const FIRST_SESSION = 'session-first' as SessionId
const SECOND_SESSION = 'session-second' as SessionId
const THIRD_SESSION = 'session-third' as SessionId
const FIRST_WORKSPACE = 'workspace-first' as WorkspaceId
const SECOND_WORKSPACE = 'workspace-second' as WorkspaceId
/* oxlint-enable typescript/no-unsafe-type-assertion */

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

function summary(
  id: SessionId,
  displayTitle: string,
  updatedAt: number,
  completed = false,
): SessionSummary {
  return {
    id,
    displayTitle,
    running: false,
    blank: false,
    updatedAt,
    ...completed ? { completed: true } : {},
  }
}

function sessionsState(secondUpdatedAt = 30): SessionListState {
  return {
    ids: [FIRST_SESSION, SECOND_SESSION, THIRD_SESSION],
    byId: {
      [FIRST_SESSION]: summary(FIRST_SESSION, 'First task', 10, true),
      [SECOND_SESSION]: summary(SECOND_SESSION, 'Second task', secondUpdatedAt),
      [THIRD_SESSION]: summary(THIRD_SESSION, 'Third task', 20, true),
    },
    current: FIRST_SESSION,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  }
}

function workspace(
  workspaceId: WorkspaceId,
  title: string,
  sessionIds: readonly SessionId[],
): WorkspaceView {
  return {
    workspaceId,
    title,
    path: `/work/${title.toLowerCase()}`,
    sessionIds: [...sessionIds],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function workspacesState(): WorkspaceListState {
  return {
    items: [
      workspace(FIRST_WORKSPACE, 'Alpha', [FIRST_SESSION, SECOND_SESSION]),
      workspace(SECOND_WORKSPACE, 'Beta', [THIRD_SESSION]),
    ],
    archivedSessionIds: [],
    state: 'idle',
    phase: 'ready',
    error: null,
    baselinesReady: true,
    recentWorkspaceId: FIRST_WORKSPACE,
  }
}

function fixture(): {
  readonly controller: ReturnType<typeof createSessionsController>
  readonly hostReorders: Array<{ workspaceId: WorkspaceId; sessionId: SessionId; before: SessionId | undefined }>
  readonly sessions: MutableSource<SessionListState>
} {
  const sessions = source(sessionsState())
  const workspaces = source(workspacesState())
  const hostReorders: Array<{
    workspaceId: WorkspaceId
    sessionId: SessionId
    before: SessionId | undefined
  }> = []
  const options: SessionsControllerOptions = {
    navigation: createNavigationStore(),
    sessions: {
      list: sessions,
      clear: () => {},
      open: () => {},
      search: query => Promise.resolve({
        ok: true,
        value: {
          items: query === 'beta' ? [{ sessionId: THIRD_SESSION, snippet: REMOTE_SNIPPET }] : [],
          hasMore: false,
        },
      }),
      fork: () => Promise.resolve(FIRST_SESSION),
      loadOlder: () => Promise.resolve(),
      rename: () => Promise.resolve(),
    },
    workspaces: {
      list: workspaces,
      startSession: () => {},
      create: () => Promise.resolve(workspace(FIRST_WORKSPACE, 'Alpha', [])),
      rename: () => Promise.resolve(workspace(FIRST_WORKSPACE, 'Alpha', [])),
      delete: () => Promise.resolve(),
      insertBefore: () => Promise.resolve(),
      insertSessionBefore: (workspaceId, sessionId, before) => {
        hostReorders.push({ workspaceId, sessionId, before })
        return Promise.resolve(workspace(workspaceId, 'Alpha', []))
      },
      archiveSession: () => Promise.resolve(),
    },
  }
  return { controller: createSessionsController(options), hostReorders, sessions }
}

function sessionTitles(controller: ReturnType<typeof createSessionsController>): string[] {
  return controller.getSnapshot().rows
    .filter(row => row.kind === 'session')
    .map(row => row.title)
}

test('switches grouped and flat views with last-updated ordering', () => {
  const { controller } = fixture()

  assert.equal(controller.getSnapshot().groupMode, 'workspace')
  assert.equal(controller.getSnapshot().orderMode, 'updated')
  assert.deepEqual(sessionTitles(controller), ['Second task', 'First task', 'Third task'])

  controller.setGroupMode('flat')
  assert.equal(controller.getSnapshot().rows.some(row => row.kind === 'workspace'), false)
  assert.deepEqual(sessionTitles(controller), ['Second task', 'Third task', 'First task'])

  controller.setGroupMode('workspace')
  assert.deepEqual(sessionTitles(controller), ['Second task', 'First task', 'Third task'])
})

test('manual ordering preserves user moves while updated mode promotes activity', async () => {
  const { controller, hostReorders, sessions } = fixture()

  controller.setOrderMode('manual')
  controller.select(`session:${FIRST_SESSION}`)
  await controller.moveSelected(-1)
  assert.deepEqual(sessionTitles(controller), ['First task', 'Second task', 'Third task'])
  assert.deepEqual(hostReorders, [{
    workspaceId: FIRST_WORKSPACE,
    sessionId: FIRST_SESSION,
    before: SECOND_SESSION,
  }])

  sessions.publish(sessionsState(100))
  assert.deepEqual(sessionTitles(controller), ['First task', 'Second task', 'Third task'])

  controller.setOrderMode('updated')
  assert.deepEqual(sessionTitles(controller), ['Second task', 'First task', 'Third task'])

  controller.setGroupMode('flat')
  controller.setOrderMode('manual')
  controller.select(`session:${THIRD_SESSION}`)
  await controller.moveSelected(1)
  assert.deepEqual(sessionTitles(controller), ['Second task', 'First task', 'Third task'])
  assert.equal(hostReorders.length, 1)
})

test('projects unviewed completion and traverses unread sessions', () => {
  const { controller, sessions } = fixture()

  assert.equal(controller.getSnapshot().unreadCount, 2)
  assert.equal(controller.getSnapshot().rows.find(row => row.sessionId === FIRST_SESSION)?.unread, true)

  controller.select(`session:${FIRST_SESSION}`)
  controller.moveUnread(1)
  assert.equal(controller.getSnapshot().activeRowKey, `session:${THIRD_SESSION}`)

  controller.select(`workspace:${FIRST_WORKSPACE}`)
  controller.toggleWorkspace()
  controller.select(`session:${THIRD_SESSION}`)
  controller.moveUnread(1)
  assert.equal(controller.getSnapshot().activeRowKey, `session:${FIRST_SESSION}`)
  assert.equal(controller.getSnapshot().rows.some(row => row.sessionId === FIRST_SESSION), true)

  const next = sessionsState()
  sessions.publish({
    ...next,
    byId: {
      ...next.byId,
      [THIRD_SESSION]: summary(THIRD_SESSION, 'Third task', 20),
    },
  })
  controller.moveUnread(1)
  assert.equal(controller.getSnapshot().activeRowKey, `session:${FIRST_SESSION}`)
  assert.equal(controller.getSnapshot().unreadCount, 1)
})

test('search includes workspace metadata and caps wire input without splitting surrogate pairs', async () => {
  const { controller } = fixture()

  controller.openInput('search')
  await controller.submitInput('beta')
  assert.deepEqual(sessionTitles(controller), ['Third task'])
  assert.equal(controller.getSnapshot().rows[0]?.detail, 'Beta')

  const oversized = `${'a'.repeat(SEARCH_QUERY_LIMIT - 1)}💻${TRAILING_TEXT}`
  const normalized = normalizeSessionSearchQuery(oversized)
  assert.equal(normalized.length, SEARCH_QUERY_LIMIT - 1)
  assert.equal(normalized.endsWith('\uD83D'), false)
})

test('caps local search matches and reports overflow', () => {
  const ids = Array.from({ length: LOCAL_SEARCH_RESULT_COUNT }, (_value, index) => {
    // Generated fixture IDs cross only the Harness brand boundary.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return `session-search-${String(index)}` as SessionId
  })
  const byId = Object.fromEntries(ids.map((id, index) => {
    return [id, summary(id, `Task ${String(index)}`, index)]
  })) as SessionListState['byId']
  const projection = projectSearch({
    ...sessionsState(),
    ids,
    byId,
    current: ids[0],
  }, {
    ...workspacesState(),
    items: [],
  }, 'task', [], false)

  assert.equal(projection.rows.length, SESSION_SEARCH_RESULT_LIMIT)
  assert.equal(projection.hasMore, true)
})
