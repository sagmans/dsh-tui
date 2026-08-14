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
  sanitizeText,
  type SessionsControllerOptions,
} from '../../src/features/sessions/model.js'

// Static fixture identities cross only the Harness brand boundary.
/* oxlint-disable typescript/no-unsafe-type-assertion */
const FIRST_SESSION = 'session-one' as SessionId
const SECOND_SESSION = 'session-two' as SessionId
const BLANK_SESSION = 'session-blank' as SessionId
const FIRST_WORKSPACE = 'workspace-one' as WorkspaceId
const SECOND_WORKSPACE = 'workspace-two' as WorkspaceId
/* oxlint-enable typescript/no-unsafe-type-assertion */

interface MutableSource<T> extends ObservableSnapshot<T> {
  publish(next: T): void
}

interface FixtureControl {
  readonly archives: SessionId[]
  readonly createdPaths: string[]
  readonly deletedWorkspaces: WorkspaceId[]
  readonly forks: SessionId[]
  readonly historyLoads: SessionId[]
  readonly opened: SessionId[]
  readonly renamedSessions: Array<{ id: SessionId; title: string }>
  readonly renamedWorkspaces: Array<{ id: WorkspaceId; title: string }>
  readonly started: Array<WorkspaceId | undefined>
  reorderWorkspace?: { id: WorkspaceId; before: WorkspaceId | undefined }
  reorderSession?: { workspaceId: WorkspaceId; id: SessionId; before: SessionId | undefined }
}

function source<T>(initial: T): MutableSource<T> {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    publish(next) {
      snapshot = next
      for (const listener of listeners) listener()
    },
  }
}

function summary(id: SessionId, title: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    displayTitle: title,
    running: false,
    blank: false,
    updatedAt: 1,
    ...overrides,
  }
}

function sessionState(): SessionListState {
  return {
    ids: [FIRST_SESSION, SECOND_SESSION, BLANK_SESSION],
    byId: {
      [FIRST_SESSION]: summary(FIRST_SESSION, 'Build terminal shell', {
        running: true,
        projectionValues: {
          sessionStats: {
            turns: 3,
            steps: 4,
            llmMs: 0,
            toolMs: 0,
            ttftMs: 0,
            ttftSteps: 0,
            decodeMs: 0,
            decodeTokens: 0,
          },
        },
      }),
      [SECOND_SESSION]: summary(SECOND_SESSION, 'Review wiring'),
      [BLANK_SESSION]: summary(BLANK_SESSION, 'New Session', { blank: true }),
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
  sessionIds: SessionId[],
): WorkspaceView {
  return {
    workspaceId,
    title,
    path: `/work/${title.toLowerCase()}`,
    sessionIds,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function workspaceState(): WorkspaceListState {
  return {
    items: [
      workspace(FIRST_WORKSPACE, 'Harness', [FIRST_SESSION, BLANK_SESSION]),
      workspace(SECOND_WORKSPACE, 'Plugin', []),
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
  readonly control: FixtureControl
  readonly controller: ReturnType<typeof createSessionsController>
  readonly navigation: ReturnType<typeof createNavigationStore>
  readonly sessions: MutableSource<SessionListState>
  readonly workspaces: MutableSource<WorkspaceListState>
} {
  const control: FixtureControl = {
    archives: [],
    createdPaths: [],
    deletedWorkspaces: [],
    forks: [],
    historyLoads: [],
    opened: [],
    renamedSessions: [],
    renamedWorkspaces: [],
    started: [],
  }
  const sessions = source(sessionState())
  const workspaces = source(workspaceState())
  const navigation = createNavigationStore()
  const options: SessionsControllerOptions = {
    navigation,
    sessions: {
      list: sessions,
      clear: () => { sessions.publish({ ...sessions.getSnapshot(), current: undefined }) },
      open: id => { control.opened.push(id) },
      search: query => Promise.resolve({
        ok: true,
        value: query === 'content'
          ? { items: [{ sessionId: SECOND_SESSION, snippet: 'content match' }], hasMore: true }
          : { items: [], hasMore: false },
      }),
      fork: ({ sessionId }) => { control.forks.push(sessionId); return Promise.resolve(SECOND_SESSION) },
      loadOlder: id => { control.historyLoads.push(id); return Promise.resolve() },
      rename: (id, title) => { control.renamedSessions.push({ id, title }); return Promise.resolve() },
    },
    workspaces: {
      list: workspaces,
      startSession: id => { control.started.push(id) },
      create: ({ path }) => {
        control.createdPaths.push(path)
        return Promise.resolve(workspace(SECOND_WORKSPACE, 'Plugin', []))
      },
      rename: (id, title) => {
        control.renamedWorkspaces.push({ id, title })
        return Promise.resolve(workspace(id, title, []))
      },
      delete: id => { control.deletedWorkspaces.push(id); return Promise.resolve() },
      insertBefore: (id, before) => {
        control.reorderWorkspace = { id, before }
        return Promise.resolve()
      },
      insertSessionBefore: (workspaceId, id, before) => {
        control.reorderSession = { workspaceId, id, before }
        return Promise.resolve(workspace(FIRST_WORKSPACE, 'Harness', [FIRST_SESSION]))
      },
      archiveSession: id => { control.archives.push(id); return Promise.resolve() },
    },
  }
  return { control, controller: createSessionsController(options), navigation, sessions, workspaces }
}

test('derives workspace groups while hiding archived and inactive blank sessions', () => {
  const { controller } = fixture()
  const snapshot = controller.getSnapshot()

  assert.deepEqual(snapshot.rows.map(row => [row.kind, row.title]), [
    ['workspace', 'Harness'],
    ['session', 'Build terminal shell'],
    ['workspace', 'Plugin'],
    ['workspace', 'Ungrouped'],
    ['session', 'Review wiring'],
  ])
  assert.equal(snapshot.rows[1]?.selected, true)
  assert.equal(snapshot.rows[1]?.detail, 'running · 3t/4s')
  assert.equal(snapshot.phase, 'ready')
})

test('moves selection, toggles groups, and opens sessions into chat', () => {
  const { control, controller } = fixture()

  controller.select('session:session-one')
  controller.move(1)
  assert.equal(controller.getSnapshot().activeRowKey, 'workspace:workspace-two')
  controller.activate()
  assert.equal(controller.getSnapshot().rows.some(row => row.key === 'workspace:ungrouped'), true)

  controller.select('session:session-two')
  controller.activate()
  assert.deepEqual(control.opened, [SECOND_SESSION])
})

test('searches shared runtime and preserves matching metadata rows', async () => {
  const { controller } = fixture()

  controller.openInput('search')
  await controller.submitInput('content')

  const snapshot = controller.getSnapshot()
  assert.equal(snapshot.input, undefined)
  assert.deepEqual(snapshot.rows.filter(row => row.kind === 'session').map(row => row.title), ['Review wiring'])
  assert.equal(snapshot.rows.find(row => row.kind === 'session')?.detail, 'content match')
  assert.equal(snapshot.searchHasMore, true)
  assert.equal(snapshot.searchQuery, 'content')
})

test('deactivation aborts transient input without leaving the Sessions route', () => {
  const { controller, navigation } = fixture()
  navigation.go('sessions')
  controller.openInput('search')

  controller.deactivate()

  assert.equal(controller.getSnapshot().input, undefined)
  assert.equal(navigation.getSnapshot().route, 'sessions')
})

test('closes the selected session view without deleting its durable session', () => {
  const { controller, navigation, sessions } = fixture()
  navigation.go('sessions')

  controller.close()

  assert.equal(sessions.getSnapshot().current, undefined)
  assert.equal(sessions.getSnapshot().ids.length, 3)
  assert.equal(navigation.getSnapshot().route, 'chat')
})

test('keeps workspace deletion bound to the confirmed row', async () => {
  const { control, controller } = fixture()
  controller.select('workspace:workspace-one')
  controller.requestDelete()
  controller.select('workspace:workspace-two')

  await controller.confirmDelete()

  assert.deepEqual(control.deletedWorkspaces, [FIRST_WORKSPACE])
})

test('keeps rename bound to the row that opened the input', async () => {
  const { control, controller } = fixture()
  controller.select('session:session-one')
  controller.openInput('rename')
  controller.select('workspace:workspace-two')

  await controller.submitInput('Pinned session')

  assert.deepEqual(control.renamedSessions, [{ id: FIRST_SESSION, title: 'Pinned session' }])
  assert.deepEqual(control.renamedWorkspaces, [])
})

test('routes create, rename, fork, archive, and delete through shared services', async () => {
  const { control, controller } = fixture()

  controller.select('workspace:workspace-two')
  controller.startSession()
  controller.openInput('create-workspace')
  await controller.submitInput('/tmp/plugin')
  controller.openInput('rename')
  await controller.submitInput('Plugin UI')
  controller.requestDelete()
  await controller.confirmDelete()

  controller.select('session:session-one')
  controller.openInput('rename')
  await controller.submitInput('Terminal shell')
  await controller.fork()
  await controller.archive()
  await controller.loadOlder()

  assert.deepEqual(control.started, [SECOND_WORKSPACE, SECOND_WORKSPACE])
  assert.deepEqual(control.createdPaths, ['/tmp/plugin'])
  assert.deepEqual(control.renamedWorkspaces, [{ id: SECOND_WORKSPACE, title: 'Plugin UI' }])
  assert.deepEqual(control.deletedWorkspaces, [SECOND_WORKSPACE])
  assert.deepEqual(control.renamedSessions, [{ id: FIRST_SESSION, title: 'Terminal shell' }])
  assert.deepEqual(control.forks, [FIRST_SESSION])
  assert.deepEqual(control.archives, [FIRST_SESSION])
  assert.deepEqual(control.historyLoads, [FIRST_SESSION])
})

test('routes workspace and session reorder through shared runtime', async () => {
  const { control, controller, workspaces } = fixture()

  controller.select('workspace:workspace-two')
  await controller.moveSelected(-1)
  const next = workspaceState()
  workspaces.publish({
    ...next,
    items: [
      workspace(FIRST_WORKSPACE, 'Harness', [FIRST_SESSION, SECOND_SESSION, BLANK_SESSION]),
      workspace(SECOND_WORKSPACE, 'Plugin', []),
    ],
  })
  controller.setOrderMode('manual')
  controller.select('session:session-one')
  await controller.moveSelected(-1)

  assert.deepEqual(control.reorderWorkspace, { id: SECOND_WORKSPACE, before: FIRST_WORKSPACE })
  assert.deepEqual(control.reorderSession, {
    workspaceId: FIRST_WORKSPACE,
    id: FIRST_SESSION,
    before: SECOND_SESSION,
  })
})

test('preserves readable Unicode while removing terminal and bidi format controls', () => {
  const bidiOverride = '\u202E'
  const bidiIsolate = '\u2066'
  const escape = '\u001B]8;;https://evil.invalid\u0007'

  assert.equal(sanitizeText(`${escape}中文 👩🏽‍💻 e\u0301 ${bidiOverride}spoof${bidiIsolate}`), '中文 👩🏽‍💻 é spoof')
})

test('preserves cursor identity across live list updates and sanitizes terminal text', () => {
  const { controller, sessions } = fixture()
  controller.select('session:session-two')
  const next = sessionState()
  sessions.publish({
    ...next,
    byId: {
      ...next.byId,
      [SECOND_SESSION]: summary(SECOND_SESSION, '\u001B]8;;https://evil.invalid\u0007Unsafe\u001B]8;;\u0007'),
    },
  })

  assert.equal(controller.getSnapshot().activeRowKey, 'session:session-two')
  assert.equal(controller.getSnapshot().rows.find(row => row.key === 'session:session-two')?.title, 'Unsafe')
})
