import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { KeyEvent, Renderable } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import type { CommandContext } from '@opentui/keymap'
import type {
  ConfigurationActionId,
  ConfigurationController,
  ConfigurationInputView,
  ConfigurationSection,
} from '../../src/features/settings/model.js'
import { settingsCommands } from '../../src/features/settings/commands.js'
import { createTuiLocale } from '../../src/services/locale.js'
import { createTuiTheme } from '../../src/services/theme.js'
import { createSettingsView } from '../../src/views/settings/root.js'

const NATIVE_RENDERER_AVAILABLE = process.versions.bun !== undefined
  || process.getBuiltinModule('node:ffi') !== undefined
const WIDTH = 100
const HEIGHT = 28
const SETTLE_DELAY_MS = 0
const SECRET_VALUE = 'native-plugin-secret'
const NOOP = (): void => {}
// Command handlers ignore target context; fixture supplies only required structural identity.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const COMMAND_CONTEXT = Object.freeze({}) as unknown as CommandContext<Renderable, KeyEvent>

function settle(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, SETTLE_DELAY_MS) })
}

function controller(calls: string[]): ConfigurationController {
  let listener = NOOP
  let input: ConfigurationInputView | undefined
  let rowIndex = 0
  const rows = [
    {
      actions: [
        { command: 'settings.action.plugin-setting.edit', enabled: true, id: 'plugin-setting.edit', label: 'EDIT', tone: 'default' },
        { command: 'settings.action.plugin-setting.reset', enabled: true, id: 'plugin-setting.reset', label: 'RESET', tone: 'danger' },
      ],
      details: 'effective 9000\nbase 60000',
      id: 'plugin-setting:shell:timeoutMs',
      state: 'success' as const,
      summary: '9000 · overridden',
      title: 'Shell · Timeout (ms)',
    },
    {
      actions: [
        { command: 'settings.action.plugin-setting.credential', enabled: true, id: 'plugin-setting.credential', label: 'SET KEY', tone: 'default' },
      ],
      details: 'Value is write-only and never displayed.',
      id: 'plugin-setting:web-search-deepseek:apiKey',
      state: 'success' as const,
      summary: 'configured · write only',
      title: 'DeepSeek search · API key',
    },
  ] as const
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
      rowIndex,
      rows,
      section: 'plugins',
      sections: ['plugins'] satisfies readonly ConfigurationSection[],
      selectedActionId: rows[rowIndex]?.actions[0]?.id,
      status: `${String(rowIndex + 1)}/${String(rows.length)}`,
    }),
    move: NOOP,
    moveAction: NOOP,
    moveSection: NOOP,
    perform: (action?: ConfigurationActionId) => {
      calls.push(`action:${action ?? 'selected'}`)
      if (action === 'plugin-setting.edit') {
        input = { kind: 'plugin-setting', title: 'Shell · Timeout (ms)', value: '' }
      } else if (action === 'plugin-setting.credential') {
        input = { kind: 'plugin-setting', secret: true, title: 'DeepSeek search · API key', value: '' }
      }
      listener()
      return Promise.resolve(true)
    },
    refresh: () => Promise.resolve(),
    selectRow: index => {
      rowIndex = index
      calls.push(`row:${String(index)}`)
      listener()
    },
    selectSection: NOOP,
    setInput: value => {
      calls.push(`${input?.secret === true ? 'secret' : 'input'}:${value}`)
      if (input?.secret !== true && input !== undefined) input = { ...input, value }
    },
    submitInput: () => {
      calls.push('save')
      input = undefined
      listener()
      return Promise.resolve(true)
    },
    subscribe: next => { listener = next; return () => { listener = NOOP } },
    syncPreferences: () => Promise.resolve(),
  }
}

async function runCommand(
  layer: ReturnType<typeof settingsCommands>,
  name: string,
): Promise<void> {
  const command = layer.commands.find(candidate => candidate.name === name)
  assert.ok(command)
  await command.run(COMMAND_CONTEXT)
}

test.skipIf(!NATIVE_RENDERER_AVAILABLE)('supports keyboard and mouse plugin setting edits, reset, cancel, and write-only keys', async () => {
  const harness = await createTestRenderer({ width: WIDTH, height: HEIGHT, bufferedOutput: 'memory' })
  const calls: string[] = []
  const settingsController = controller(calls)
  const view = createSettingsView(
    harness.renderer,
    createTuiTheme({ color: true }),
    createTuiLocale({ locale: 'en' }),
    settingsController,
  )
  const layer = settingsCommands(settingsController, NOOP, () => true)
  harness.renderer.root.add(view)

  try {
    await harness.flush()
    assert.match(harness.captureCharFrame(), /Shell · Timeout/u)

    await runCommand(layer, 'settings.action.plugin-setting.edit')
    await settle()
    await harness.flush()
    await harness.mockInput.typeText('12000')
    const keyboardSave = view.findDescendantById('settings-input-save')
    assert.ok(keyboardSave)
    keyboardSave.focus()
    harness.mockInput.pressEnter()
    await settle()
    assert.equal(calls.includes('input:12000'), true)
    assert.equal(calls.includes('save'), true)
    await harness.flush()

    const reset = view.findDescendantById('settings-action-plugin-setting.reset')
    assert.ok(reset)
    await harness.mockMouse.click(reset.screenX + 1, reset.screenY)
    await settle()
    assert.equal(calls.at(-1), 'action:plugin-setting.reset')
    await harness.flush()

    const edit = view.findDescendantById('settings-action-plugin-setting.edit')
    assert.ok(edit)
    await harness.mockMouse.click(edit.screenX + 1, edit.screenY)
    await settle()
    await harness.flush()
    const cancel = view.findDescendantById('settings-input-cancel')
    assert.ok(cancel)
    await harness.mockMouse.click(cancel.screenX + 1, cancel.screenY)
    await settle()
    assert.equal(calls.at(-1), 'cancel')
    await harness.flush()

    const credentialRow = view.findDescendantById('settings-row-1')
    assert.ok(credentialRow)
    await harness.mockMouse.click(credentialRow.screenX + 1, credentialRow.screenY)
    await settle()
    await harness.flush()
    const setKey = view.findDescendantById('settings-action-plugin-setting.credential')
    assert.ok(setKey)
    await harness.mockMouse.click(setKey.screenX + 1, setKey.screenY)
    await settle()
    await harness.flush()
    await harness.mockInput.typeText(SECRET_VALUE)
    assert.doesNotMatch(harness.captureCharFrame(), new RegExp(SECRET_VALUE, 'u'))
    const save = view.findDescendantById('settings-input-save')
    assert.ok(save)
    await harness.mockMouse.click(save.screenX + 1, save.screenY)
    await settle()
    assert.equal(calls.includes(`secret:${SECRET_VALUE}`), true)
  } finally {
    view.destroyRecursively()
    harness.renderer.destroy()
  }
})
