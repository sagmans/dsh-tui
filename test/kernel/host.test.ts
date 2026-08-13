import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { CliRenderer } from '@opentui/core'
import { createNavigationStore } from '../../src/kernel/navigation.js'
import { createTuiHost } from '../../src/services/host.js'

interface FocusControl {
  currentId?: string
  focused: string[]
}

function rendererFixture(control: FocusControl): CliRenderer {
  const targets = new Map([
    ['composer', { id: 'composer', focus: () => { control.focused.push('composer') } }],
    ['palette', { id: 'palette', focus: () => { control.focused.push('palette') } }],
  ])
  // Focus contract needs identity and lookup only; native rendering remains renderer-owned.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return {
    get currentFocusedRenderable() {
      return control.currentId === undefined ? null : targets.get(control.currentId)
    },
    root: { findDescendantById: (id: string) => targets.get(id) },
  } as unknown as CliRenderer
}

test('captures and restores focus across nested overlays', () => {
  const control: FocusControl = { currentId: 'composer', focused: [] }
  const navigation = createNavigationStore()
  const host = createTuiHost(rendererFixture(control), navigation)

  host.openOverlay({ id: 'palette' })
  assert.equal(navigation.getSnapshot().overlays[0]?.restoreFocus, 'composer')
  control.currentId = 'palette'
  host.openOverlay({ id: 'help' })
  assert.equal(navigation.getSnapshot().overlays[1]?.restoreFocus, 'palette')

  assert.equal(host.closeOverlay()?.id, 'help')
  assert.equal(host.closeOverlay()?.id, 'palette')
  assert.deepEqual(control.focused, ['palette', 'composer'])
})

test('allows an explicit restoration target and tolerates removed targets', () => {
  const control: FocusControl = { focused: [] }
  const navigation = createNavigationStore()
  const host = createTuiHost(rendererFixture(control), navigation)

  host.openOverlay({ id: 'help', restoreFocus: 'removed-target' })

  assert.doesNotThrow(() => host.closeOverlay())
  assert.deepEqual(control.focused, [])
})
