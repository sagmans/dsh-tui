import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { createNavigationStore } from '../../src/kernel/navigation.js'
import { createShellController, DEFAULT_SHELL_BINDINGS } from '../../src/features/shell/model.js'

// Test identities stay static; branding belongs to the Harness boundary.
/* oxlint-disable typescript/no-unsafe-type-assertion */
const FIRST_ID = 'session-one' as SessionId
const SECOND_ID = 'session-two' as SessionId
/* oxlint-enable typescript/no-unsafe-type-assertion */

function noop(): void {}

function summary(id: SessionId, displayTitle: string, running = false): SessionSummary {
  return { id, displayTitle, running, blank: false, updatedAt: 1 }
}

function sessionState(current: SessionId | undefined = FIRST_ID): SessionListState {
  return {
    ids: [FIRST_ID, SECOND_ID],
    byId: {
      [FIRST_ID]: summary(FIRST_ID, 'Implement terminal shell'),
      [SECOND_ID]: summary(SECOND_ID, 'Investigate plugin wiring', true),
    },
    current,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  }
}

test('projects a minimal zen shell from shared session state', () => {
  const navigation = createNavigationStore()
  const controller = createShellController({
    navigation,
    sessions: {
      getSnapshot: () => sessionState(),
      subscribe: () => () => {},
      open: () => {},
      clear: () => {},
    },
  })

  assert.deepEqual(controller.getSnapshot(), {
    route: 'chat',
    zen: true,
    activeSessionTitle: 'Implement terminal shell',
    activeSessionRunning: false,
    sessionCount: 2,
    overlay: undefined,
    paletteCommand: 'route.chat',
  })
})

test('maps configurable hotkeys to routes and overlay toggles', () => {
  const navigation = createNavigationStore()
  const opened: SessionId[] = []
  const controller = createShellController({
    bindings: { ...DEFAULT_SHELL_BINDINGS, routeSessions: 's' },
    navigation,
    sessions: {
      getSnapshot: () => sessionState(),
      subscribe: () => () => {},
      open: id => { opened.push(id) },
      clear: () => {},
    },
  })

  controller.run('route.sessions')
  assert.equal(controller.getSnapshot().route, 'sessions')
  controller.run('session.next')
  assert.deepEqual(opened, [SECOND_ID])
  controller.run('shell.palette')
  assert.equal(controller.getSnapshot().overlay, 'palette')
  assert.equal(controller.getSnapshot().paletteCommand, 'route.chat')
  controller.run('palette.next')
  assert.equal(controller.getSnapshot().paletteCommand, 'route.sessions')
  controller.run('palette.run')
  assert.equal(controller.getSnapshot().route, 'sessions')
  assert.equal(controller.getSnapshot().overlay, undefined)
  assert.equal(controller.bindings.palette, '<leader>p')
  assert.equal(controller.bindings.previousAlternate, 'ctrl+p')
  controller.run('shell.help')
  controller.run('shell.escape')
  assert.equal(controller.getSnapshot().overlay, undefined)
  assert.equal(controller.bindings.routeSessions, 's')
})

test('keeps every global binding unique', () => {
  const bindings = Object.values(DEFAULT_SHELL_BINDINGS)
  assert.equal(new Set(bindings).size, bindings.length)
})

test('requests renderer teardown through the quit command', () => {
  const navigation = createNavigationStore()
  let quitCalls = 0
  const controller = createShellController({
    navigation,
    onQuit: () => { quitCalls += 1 },
    sessions: {
      getSnapshot: () => sessionState(),
      subscribe: () => () => {},
      open: () => {},
      clear: () => {},
    },
  })

  controller.run('shell.quit')
  assert.equal(quitCalls, 1)
})

test('keeps mouse actions behaviorally equivalent to command actions', () => {
  const navigation = createNavigationStore()
  const opened: SessionId[] = []
  const controller = createShellController({
    navigation,
    sessions: {
      getSnapshot: () => sessionState(),
      subscribe: () => () => {},
      open: id => { opened.push(id) },
      clear: () => {},
    },
  })

  controller.run('route.inspect')
  assert.equal(controller.getSnapshot().route, 'inspect')
  controller.openRoute('chat')
  assert.equal(controller.getSnapshot().route, 'chat')
  controller.openSession(SECOND_ID)
  assert.deepEqual(opened, [SECOND_ID])
})

test('publishes shared-session and navigation changes and disposes subscriptions', () => {
  const navigation = createNavigationStore()
  let sessionListener = noop
  let sessionUnsubscribed = false
  const controller = createShellController({
    navigation,
    sessions: {
      getSnapshot: () => sessionState(),
      subscribe(listener) { sessionListener = listener; return () => { sessionUnsubscribed = true } },
      open: () => {},
      clear: () => {},
    },
  })
  let notifications = 0
  const unsubscribe = controller.subscribe(() => { notifications += 1 })

  navigation.go('settings')
  sessionListener()
  assert.equal(notifications, 2)

  unsubscribe()
  controller.dispose()
  assert.equal(sessionUnsubscribed, true)
})
