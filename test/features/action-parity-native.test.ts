import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { KeyEvent, Renderable } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import type { CommandContext } from '@opentui/keymap'
import type {
  ConfigurationActionId,
  ConfigurationController,
  ConfigurationSection,
} from '../../src/features/settings/model.js'
import { settingsCommands } from '../../src/features/settings/commands.js'
import { createTuiTheme } from '../../src/services/theme.js'
import { createSettingsView } from '../../src/views/settings/root.js'

const NATIVE_RENDERER_AVAILABLE = process.versions.bun !== undefined
  || process.getBuiltinModule('node:ffi') !== undefined
const WIDTH = 80
const HEIGHT = 24
const SETTLE_DELAY_MS = 0
const NOOP = (): void => {}
const ACTION_IDS = Object.freeze(['preset.open', 'preset.copy'] as const satisfies readonly ConfigurationActionId[])
// Command-layer action handlers do not consume target context; this fixture preserves the public call signature.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const COMMAND_CONTEXT = Object.freeze({}) as unknown as CommandContext<Renderable, KeyEvent>

function settle(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, SETTLE_DELAY_MS) })
}

function controller(calls: string[]): ConfigurationController {
  return {
    activate: () => Promise.resolve(),
    cancelInput: NOOP,
    dispose: NOOP,
    getSnapshot: () => ({
      busy: false,
      confirmation: undefined,
      error: undefined,
      input: undefined,
      rowIndex: 0,
      rows: [{
        actions: [
          { command: 'settings.action.preset.open', enabled: true, id: 'preset.open', label: 'OPEN', tone: 'default' },
          { command: 'settings.action.preset.copy', enabled: true, id: 'preset.copy', label: 'COPY', tone: 'default' },
          { command: 'settings.action.preset.remove', enabled: false, id: 'preset.remove', label: 'REMOVE', tone: 'danger' },
        ],
        details: 'Preset details',
        id: 'preset:mine',
        state: 'idle',
        summary: 'user',
        title: 'Mine',
      }],
      section: 'presets',
      sections: ['presets'] satisfies readonly ConfigurationSection[],
      selectedActionId: 'preset.open',
      status: '1/1',
    }),
    move: NOOP,
    moveAction: NOOP,
    moveSection: NOOP,
    perform: (action?: ConfigurationActionId) => {
      calls.push(`action:${action ?? 'selected'}`)
      return Promise.resolve(true)
    },
    refresh: () => Promise.resolve(),
    selectRow: NOOP,
    selectSection: NOOP,
    setInput: NOOP,
    submitInput: () => Promise.resolve(true),
    subscribe: () => NOOP,
  }
}

test.skipIf(!NATIVE_RENDERER_AVAILABLE)('routes keyboard commands and mouse clicks through each exact enabled action', async () => {
  const harness = await createTestRenderer({ width: WIDTH, height: HEIGHT, bufferedOutput: 'memory' })
  const calls: string[] = []
  const actionController = controller(calls)
  const view = createSettingsView(harness.renderer, createTuiTheme({ color: true }), actionController)
  const layer = settingsCommands(actionController, NOOP, () => true)
  harness.renderer.root.add(view)

  try {
    await harness.flush()
    assert.match(harness.captureCharFrame(), /› OPEN/u)

    for (const id of ACTION_IDS) {
      const command = layer.commands.find(candidate => candidate.name === `settings.action.${id}`)
      assert.ok(command)
      await command.run(COMMAND_CONTEXT)
      const target = view.findDescendantById(`settings-action-${id}`)
      assert.ok(target)
      await harness.mockMouse.click(target.screenX + 1, target.screenY)
      await settle()
    }

    const disabled = view.findDescendantById('settings-action-preset.remove')
    assert.ok(disabled)
    await harness.mockMouse.click(disabled.screenX + 1, disabled.screenY)
    await settle()

    assert.deepEqual(calls, [
      'action:preset.open',
      'action:preset.open',
      'action:preset.copy',
      'action:preset.copy',
    ])
  } finally {
    view.destroyRecursively()
    harness.renderer.destroy()
  }
})
