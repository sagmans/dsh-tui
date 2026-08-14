import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createTestRenderer } from '@opentui/core/testing'
import type {
  ConfigurationActionId,
  ConfigurationController,
  ConfigurationSection,
  ConfigurationSnapshotView,
} from '../../src/features/settings/model.js'
import { createTuiTheme } from '../../src/services/theme.js'
import { createSettingsView } from '../../src/views/settings/root.js'

const NATIVE_RENDERER_AVAILABLE = process.versions.bun !== undefined
  || process.getBuiltinModule('node:ffi') !== undefined
const WIDTH = 100
const HEIGHT = 28
const SETTLE_DELAY_MS = 0
const NOOP = (): void => {}

function settle(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, SETTLE_DELAY_MS) })
}

function controller(calls: string[]): ConfigurationController {
  let listener = NOOP
  let input: ConfigurationSnapshotView['input']
  return {
    activate: () => Promise.resolve(),
    cancelInput: () => {
      calls.push('cancel')
      input = undefined
      listener()
    },
    dispose: NOOP,
    getSnapshot: () => ({
      busy: false,
      confirmation: undefined,
      error: undefined,
      input,
      rowIndex: 0,
      rows: [{
        actions: [{
          command: 'settings.action.provider.create',
          enabled: true,
          id: 'provider.create',
          label: 'CREATE',
          tone: 'positive',
        }],
        details: 'Create a provider',
        id: 'provider:create',
        state: 'idle',
        summary: 'staged form',
        title: 'Add custom provider',
      }],
      section: 'providers',
      sections: ['models', 'providers'] satisfies readonly ConfigurationSection[],
      selectedActionId: 'provider.create',
      status: '1/1',
    }),
    move: NOOP,
    moveAction: NOOP,
    moveSection: NOOP,
    perform: (action?: ConfigurationActionId) => {
      calls.push(`action:${action ?? 'selected'}`)
      input = { kind: 'provider', title: 'Provider id', value: '' }
      listener()
      return Promise.resolve(true)
    },
    refresh: () => Promise.resolve(),
    selectRow: index => { calls.push(`row:${String(index)}`) },
    selectSection: section => { calls.push(`tab:${section}`) },
    setInput: value => { calls.push(`input:${value}`) },
    submitInput: () => {
      calls.push('save')
      input = { kind: 'provider', title: 'Display name (optional)', value: '' }
      listener()
      return Promise.resolve(true)
    },
    subscribe: next => { listener = next; return () => { listener = NOOP } },
  }
}

test.skipIf(!NATIVE_RENDERER_AVAILABLE)('supports mouse provider navigation and staged form controls', async () => {
  const harness = await createTestRenderer({ width: WIDTH, height: HEIGHT, bufferedOutput: 'memory' })
  const calls: string[] = []
  const view = createSettingsView(harness.renderer, createTuiTheme({ color: true }), controller(calls))
  harness.renderer.root.add(view)

  try {
    await harness.flush()
    const providerTab = view.findDescendantById('settings-tab-providers')
    const createAction = view.findDescendantById('settings-action-provider.create')
    assert.ok(providerTab)
    assert.ok(createAction)
    await harness.mockMouse.click(providerTab.screenX + 1, providerTab.screenY)
    await harness.mockMouse.click(createAction.screenX + 1, createAction.screenY)
    await settle()
    await harness.flush()

    assert.match(harness.captureCharFrame(), /Provider id/u)
    await harness.mockInput.typeText('acme-gateway')
    const save = view.findDescendantById('settings-input-save')
    assert.ok(save)
    await harness.mockMouse.click(save.screenX + 1, save.screenY)
    await settle()
    await harness.flush()

    assert.match(harness.captureCharFrame(), /Display name/u)
    const cancel = view.findDescendantById('settings-input-cancel')
    assert.ok(cancel)
    await harness.mockMouse.click(cancel.screenX + 1, cancel.screenY)
    await settle()

    assert.deepEqual(calls.slice(0, 2), ['tab:providers', 'action:provider.create'])
    assert.equal(calls.includes('input:acme-gateway'), true)
    assert.deepEqual(calls.slice(-2), ['save', 'cancel'])
  } finally {
    view.destroyRecursively()
    harness.renderer.destroy()
  }
})
