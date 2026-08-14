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
const WIDTH = 80
const HEIGHT = 24
const SECRET_VALUE = 'terminal-secret-value'
const SETTLE_DELAY_MS = 0
const NOOP_LISTENER = (): void => {}

function settle(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, SETTLE_DELAY_MS) })
}

function controller(calls: string[]): ConfigurationController {
  let listener = NOOP_LISTENER
  let input: ConfigurationSnapshotView['input']
  return {
    activate: () => Promise.resolve(),
    cancelInput: () => {},
    dispose: () => {},
    getSnapshot: () => ({
      busy: false,
      confirmation: undefined,
      error: undefined,
      input,
      rowIndex: 0,
      rows: [{
        actions: [{
          command: 'settings.action.credential.set',
          enabled: true,
          id: 'credential.set',
          label: 'SET',
          tone: 'default',
        }],
        details: 'Write-only credential',
        id: 'credential:DEEPSEEK_API_KEY',
        state: 'success',
        summary: 'configured',
        title: 'DEEPSEEK_API_KEY',
      }],
      section: 'credentials',
      sections: ['models', 'access', 'presets', 'settings', 'credentials', 'plugins', 'extensions'],
      selectedActionId: 'credential.set',
      status: '1/1',
    }),
    move: delta => { calls.push(`move:${delta}`) },
    moveAction: delta => { calls.push(`action-cursor:${delta}`) },
    moveSection: delta => { calls.push(`section:${delta}`) },
    perform: (action?: ConfigurationActionId) => {
      calls.push(`action:${action}`)
      input = { kind: 'credential', secret: true, title: 'Set credential', value: '' }
      listener()
      return Promise.resolve(true)
    },
    refresh: () => Promise.resolve(),
    selectRow: index => { calls.push(`row:${index}`) },
    selectSection: (section: ConfigurationSection) => { calls.push(`tab:${section}`) },
    setInput: value => { calls.push(`secret:${value}`) },
    submitInput: () => Promise.resolve(true),
    subscribe: next => { listener = next; return () => { listener = NOOP_LISTENER } },
  }
}

test.skipIf(!NATIVE_RENDERER_AVAILABLE)('supports mouse configuration controls and masks credential input', async () => {
  const harness = await createTestRenderer({ width: WIDTH, height: HEIGHT, bufferedOutput: 'memory' })
  const calls: string[] = []
  const view = createSettingsView(harness.renderer, createTuiTheme({ color: true }), controller(calls))
  harness.renderer.root.add(view)

  try {
    await harness.flush()
    assert.match(harness.captureCharFrame(), /DEEPSEEK_API_KEY/u)

    const action = view.findDescendantById('settings-action-credential.set')
    assert.ok(action)
    await harness.mockMouse.click(action.screenX + 1, action.screenY)
    await settle()
    await harness.flush()

    await harness.mockInput.typeText(SECRET_VALUE)
    await harness.flush()
    const frame = harness.captureCharFrame()
    assert.doesNotMatch(frame, new RegExp(SECRET_VALUE, 'u'))
    assert.match(frame, /•+/u)
    assert.equal(calls.at(-1), `secret:${SECRET_VALUE}`)
    harness.mockInput.pressBackspace()
    await harness.mockInput.pasteBracketedText('x')
    await harness.flush()
    assert.equal(calls.at(-1), `secret:${SECRET_VALUE.slice(0, -1)}x`)
    assert.doesNotMatch(harness.captureCharFrame(), /terminal-secret/u)

    for (const id of ['settings-row-0', 'settings-tab-extensions']) {
      const target = view.findDescendantById(id)
      assert.ok(target)
      await harness.mockMouse.click(target.screenX + 1, target.screenY)
    }
    assert.deepEqual(calls.slice(-2), ['row:0', 'tab:extensions'])
  } finally {
    view.destroyRecursively()
    harness.renderer.destroy()
  }
})
