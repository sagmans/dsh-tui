import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { KeyEvent, Renderable } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import type { CommandContext } from '@opentui/keymap'
import type { ConversationController } from '../../src/features/conversation/model.js'
import type {
  ConfigurationActionId,
  ConfigurationController,
  ConfigurationRowView,
  ConfigurationSection,
} from '../../src/features/settings/model.js'
import { settingsCommands } from '../../src/features/settings/commands.js'
import { createTuiTheme } from '../../src/services/theme.js'
import { createConversationView } from '../../src/views/conversation/root.js'
import { createSettingsView } from '../../src/views/settings/root.js'

const NATIVE_RENDERER_AVAILABLE = process.versions.bun !== undefined
  || process.getBuiltinModule('node:ffi') !== undefined
const WIDTH = 100
const HEIGHT = 28
const SETTLE_DELAY_MS = 0
const NOOP = (): void => {}
const ACTIONS = Object.freeze([
  'access.select', 'access.default', 'preset.select',
] as const satisfies readonly ConfigurationActionId[])
// Command handlers ignore render context; fixture preserves public signature.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const COMMAND_CONTEXT = Object.freeze({}) as unknown as CommandContext<Renderable, KeyEvent>

function settle(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, SETTLE_DELAY_MS) })
}

function controller(calls: string[]): ConfigurationController {
  let listener = NOOP
  let rowIndex = 0
  const rows: ConfigurationRowView[] = [
    {
      actions: [{ command: 'settings.action.access.select', enabled: true, id: 'access.select', label: 'SELECT', tone: 'positive' as const }],
      details: 'Current session only', id: 'access:workspace-write', state: 'idle' as const,
      summary: 'current session', title: 'Workspace Write',
    },
    {
      actions: [{ command: 'settings.action.access.default', enabled: true, id: 'access.default', label: 'MAKE DEFAULT', tone: 'positive' as const }],
      details: 'Future sessions', id: 'access-default:workspace-write', state: 'idle' as const,
      summary: 'new sessions', title: 'Workspace Write · default',
    },
    {
      actions: [{ command: 'settings.action.preset.select', enabled: true, id: 'preset.select', label: 'SELECT', tone: 'positive' as const }],
      details: 'Blank session composition', id: 'preset:code', state: 'idle' as const,
      summary: 'system', title: 'Code',
    },
  ]
  return {
    activate: () => Promise.resolve(),
    cancelInput: NOOP,
    dispose: NOOP,
    getSnapshot: () => ({
      busy: false,
      confirmation: undefined,
      error: undefined,
      input: undefined,
      rowIndex,
      rows,
      section: 'access',
      sections: ['access', 'presets'] satisfies readonly ConfigurationSection[],
      selectedActionId: rows[rowIndex]?.actions[0]?.id,
      status: `${String(rowIndex + 1)}/${String(rows.length)}`,
    }),
    move: NOOP,
    moveAction: NOOP,
    moveSection: NOOP,
    perform: (action?: ConfigurationActionId) => {
      calls.push(`action:${action ?? 'selected'}`)
      return Promise.resolve(true)
    },
    refresh: () => Promise.resolve(),
    selectRow: index => { rowIndex = index; listener() },
    selectSection: section => { calls.push(`tab:${section}`) },
    setInput: NOOP,
    submitInput: () => Promise.resolve(false),
    subscribe: next => { listener = next; return () => { listener = NOOP } },
  }
}

function conversationController(calls: string[]): ConversationController {
  return {
    beginAttachment: NOOP,
    beginExport: NOOP,
    beginQueueEdit: NOOP,
    cancel: () => Promise.resolve(),
    cancelInput: NOOP,
    clearAttachments: NOOP,
    closeInformation: NOOP,
    compact: () => Promise.resolve(false),
    complete: () => Promise.resolve(),
    dismissTrigger: NOOP,
    dispose: NOOP,
    getSnapshot: () => ({
      accessPreset: 'workspace-write',
      agentPreset: 'code',
      attachments: [],
      busy: false,
      busyEnter: 'queue',
      busyEnterAvailable: false,
      busyEnterBusy: false,
      draft: '',
      error: undefined,
      hasMore: false,
      informationSection: undefined,
      input: undefined,
      context: undefined,
      goal: undefined,
      lifecycle: [],
      lines: [],
      loadingOlder: false,
      modelAvailable: true,
      modelEffort: 'high',
      modelLabel: 'flash',
      modelRoutable: true,
      phase: 'empty',
      primarySendMode: 'queue',
      queue: [],
      queueMutable: false,
      running: false,
      sessionId: undefined,
      statistics: undefined,
      status: 'Ready',
      suggestions: [],
      plan: undefined,
      title: 'Preset seats',
      todos: [],
      trigger: undefined,
    }),
    launchTrigger: NOOP,
    loadOlder: () => Promise.resolve(),
    moveTrigger: NOOP,
    openInformation: NOOP,
    openModelSelection: entry => { calls.push(`model:${entry}`) },
    openPreferences: section => { calls.push(`seat:${section}`) },
    pickTrigger: NOOP,
    pickTriggerHighlight: NOOP,
    removeAttachment: NOOP,
    removeQueue: () => Promise.resolve(false),
    scroll: NOOP,
    scrollOffset: () => 0,
    send: () => Promise.resolve(false),
    sendAlternateDraft: () => Promise.resolve(false),
    sendDraft: () => Promise.resolve(false),
    exitPlanMode: () => Promise.resolve(false),
    setDraft: NOOP,
    setInput: NOOP,
    steerQueue: () => Promise.resolve(false),
    steerQueueAll: () => Promise.resolve(false),
    submitInput: () => Promise.resolve(false),
    toggleBusyEnter: () => Promise.resolve(false),
    subscribe: () => NOOP,
  }
}

async function runActionCommand(
  controllerValue: ConfigurationController,
  calls: string[],
  action: ConfigurationActionId,
): Promise<void> {
  const layer = settingsCommands(controllerValue, NOOP, () => true)
  const command = layer.commands.find(candidate => candidate.name === `settings.action.${action}`)
  assert.ok(command)
  await command.run(COMMAND_CONTEXT)
  assert.equal(calls.at(-1), `action:${action}`)
}

test.skipIf(!NATIVE_RENDERER_AVAILABLE)('opens composer access and preset seats with mouse', async () => {
  const harness = await createTestRenderer({ width: WIDTH, height: HEIGHT, bufferedOutput: 'memory' })
  const calls: string[] = []
  const view = createConversationView(harness.renderer, createTuiTheme({ color: true }), conversationController(calls))
  harness.renderer.root.add(view)

  try {
    await harness.flush()
    for (const [id, expected] of [
      ['conversation-model', 'model:composer'],
      ['conversation-access', 'seat:access'],
      ['conversation-preset', 'seat:presets'],
    ] as const) {
      const seat = view.findDescendantById(id)
      assert.ok(seat)
      await harness.mockMouse.click(seat.screenX + 1, seat.screenY)
      await settle()
      assert.equal(calls.at(-1), expected)
    }
    assert.match(harness.captureCharFrame(), /PRESET code/u)
    const composer = view.findDescendantById('conversation-composer')
    assert.ok(composer)
    await harness.mockMouse.click(composer.screenX + 1, composer.screenY)
    harness.mockInput.pressKey('m', { meta: true })
    harness.mockInput.pressKey('a', { meta: true })
    harness.mockInput.pressKey('p', { meta: true })
    await settle()
    assert.deepEqual(calls.slice(-3), ['model:composer', 'seat:access', 'seat:presets'])
  } finally {
    view.destroyRecursively()
    harness.renderer.destroy()
  }
})

test.skipIf(!NATIVE_RENDERER_AVAILABLE)('offers preset and permission outcomes through keyboard and mouse', async () => {
  const harness = await createTestRenderer({ width: WIDTH, height: HEIGHT, bufferedOutput: 'memory' })
  const calls: string[] = []
  const actionController = controller(calls)
  const view = createSettingsView(harness.renderer, createTuiTheme({ color: true }), actionController)
  harness.renderer.root.add(view)

  try {
    await harness.flush()
    for (const [index, action] of ACTIONS.entries()) {
      await runActionCommand(actionController, calls, action)
      const row = view.findDescendantById(`settings-row-${String(index)}`)
      assert.ok(row)
      await harness.mockMouse.click(row.screenX + 1, row.screenY)
      await settle()
      await harness.flush()
      const target = view.findDescendantById(`settings-action-${action}`)
      assert.ok(target)
      await harness.mockMouse.click(target.screenX + 1, target.screenY)
      await settle()
    }
    const presetTab = view.findDescendantById('settings-tab-presets')
    assert.ok(presetTab)
    await harness.mockMouse.click(presetTab.screenX + 1, presetTab.screenY)
    assert.equal(calls.at(-1), 'tab:presets')
  } finally {
    view.destroyRecursively()
    harness.renderer.destroy()
  }
})
