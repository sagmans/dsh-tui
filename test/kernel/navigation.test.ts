import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createNavigationStore } from '../../src/kernel/navigation.js'

const FIRST_OVERLAY = { id: 'palette', restoreFocus: 'chat-input' } as const
const SECOND_OVERLAY = { id: 'help', restoreFocus: 'palette-search' } as const

test('moves between full-screen routes and preserves the previous route', () => {
  const navigation = createNavigationStore()

  assert.deepEqual(navigation.getSnapshot(), {
    route: 'chat',
    previousRoute: undefined,
    overlays: [],
  })
  navigation.go('sessions')
  assert.equal(navigation.getSnapshot().route, 'sessions')
  assert.equal(navigation.getSnapshot().previousRoute, 'chat')
  navigation.back()
  assert.equal(navigation.getSnapshot().route, 'chat')
})

test('restores focus targets in last-opened-first-closed order', () => {
  const navigation = createNavigationStore()

  navigation.openOverlay(FIRST_OVERLAY)
  navigation.openOverlay(SECOND_OVERLAY)
  assert.deepEqual(navigation.closeOverlay(), SECOND_OVERLAY)
  assert.deepEqual(navigation.closeOverlay(), FIRST_OVERLAY)
  assert.equal(navigation.closeOverlay(), undefined)
})

test('notifies only when navigation state changes', () => {
  const navigation = createNavigationStore()
  let notifications = 0
  const unsubscribe = navigation.subscribe(() => { notifications += 1 })

  navigation.go('chat')
  navigation.openOverlay(FIRST_OVERLAY)
  navigation.closeOverlay()
  navigation.closeOverlay()

  assert.equal(notifications, 2)
  unsubscribe()
})
