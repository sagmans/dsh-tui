import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { KeyEvent, Renderable } from '@opentui/core'
import type { CommandContext } from '@opentui/keymap'
import type {
  ConfigurationActionId,
  ConfigurationController,
  ConfigurationSection,
} from '../../src/features/settings/model.js'
import { settingsCommands } from '../../src/features/settings/commands.js'
import { CONFIGURATION_ACTIONS } from '../../src/features/settings/projection-types.js'
import type {
  OperationActionId,
  OperationsController,
  OperationsSection,
} from '../../src/features/operations/model.js'
import { operationsOverlayCommands } from '../../src/features/operations/commands.js'
import type { TuiCommandLayer } from '../../src/contracts/commands.js'

const SETTINGS_ACTION_IDS = Object.freeze([
  'model.select',
  'provider.create',
  'provider.edit',
  'provider.discover',
  'provider.remove',
  'provider.credential',
  'provider.model.add',
  'provider.model.edit',
  'provider.model.remove',
  'provider.model.adopt',
  'access.select',
  'access.default',
  'preset.select',
  'preset.default',
  'preset.view',
  'preset.copy',
  'preset.open',
  'preset.remove',
  'settings.open',
  'settings.reset',
  'credential.set',
  'credential.unset',
  'extension.run',
  'extension.stop',
  'extension.remove',
  'theme.light',
  'theme.dark',
  'theme.system',
  'locale.zh',
  'locale.en',
] as const satisfies readonly ConfigurationActionId[])
const OPERATION_ACTION_IDS = Object.freeze([
  'feedback.clear',
  'feedback.negative',
  'feedback.note',
  'feedback.positive',
  'goal.clear',
  'goal.complete',
  'goal.edit',
  'goal.pause',
  'goal.resume',
  'plan.off',
  'subagent.open',
  'trajectory.open',
  'workflow.open',
] as const satisfies readonly OperationActionId[])
const SETTINGS_PREFIX = 'settings.action.'
const OPERATIONS_PREFIX = 'operations.action.'
const NOOP = (): void => {}
// Command-layer action handlers do not consume target context; this fixture preserves the public call signature.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const COMMAND_CONTEXT = Object.freeze({}) as unknown as CommandContext<Renderable, KeyEvent>

interface SettingsFixture extends ConfigurationController {
  moveAction(delta: number): void
}

interface OperationsFixture extends OperationsController {
  moveAction(delta: number): void
}

function settingsController(calls: string[]): SettingsFixture {
  const actions = SETTINGS_ACTION_IDS.map(id => ({
    command: `${SETTINGS_PREFIX}${id}`,
    enabled: true,
    id,
    label: id,
    tone: 'default' as const,
  }))
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
      rows: [{ actions, details: '', id: 'settings-row', state: 'idle', summary: '', title: 'Settings' }],
      section: 'settings',
      sections: ['settings'] satisfies readonly ConfigurationSection[],
      selectedActionId: actions[0]?.id,
      status: '',
    }),
    move: delta => { calls.push(`row:${delta}`) },
    moveAction: delta => { calls.push(`action-cursor:${delta}`) },
    moveSection: delta => { calls.push(`section:${delta}`) },
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
    syncPreferences: () => Promise.resolve(),
  }
}

function operationsController(calls: string[]): OperationsFixture {
  const actions = OPERATION_ACTION_IDS.map(id => ({
    command: `${OPERATIONS_PREFIX}${id}`,
    enabled: true,
    id,
    label: id,
    tone: 'default' as const,
  }))
  return {
    cancelInput: NOOP,
    close: NOOP,
    dispose: NOOP,
    getSnapshot: () => ({
      busy: false,
      confirmation: undefined,
      error: undefined,
      input: undefined,
      overlayId: 'operations',
      rowIndex: 0,
      rows: [{ actions, details: '', id: 'operations-row', state: 'idle', summary: '', title: 'Operations' }],
      section: 'goal',
      sections: ['goal'] satisfies readonly OperationsSection[],
      selectedActionId: actions[0]?.id,
      status: '',
    }),
    move: delta => { calls.push(`row:${delta}`) },
    moveAction: delta => { calls.push(`action-cursor:${delta}`) },
    moveSection: delta => { calls.push(`section:${delta}`) },
    open: () => Promise.resolve(),
    perform: (action?: OperationActionId) => {
      calls.push(`action:${action ?? 'selected'}`)
      return Promise.resolve(true)
    },
    selectRow: NOOP,
    selectSection: NOOP,
    setInput: NOOP,
    submitInput: () => Promise.resolve(true),
    subscribe: () => NOOP,
    toggle: () => Promise.resolve(),
  }
}

async function run(layer: TuiCommandLayer, name: string): Promise<void> {
  const command = layer.commands.find(candidate => candidate.name === name)
  assert.ok(command, name)
  await command.run(COMMAND_CONTEXT)
}

function commandNames(layer: TuiCommandLayer): readonly string[] {
  return layer.commands.map(command => command.name)
}

test('describes projected actions with one command identity and enabled state', () => {
  assert.deepEqual(CONFIGURATION_ACTIONS.presetOpen, {
    command: `${SETTINGS_PREFIX}preset.open`,
    enabled: true,
    id: 'preset.open',
    label: 'OPEN',
    tone: 'default',
  })
})

test('registers exact settings commands plus universal action-cursor navigation', async () => {
  const calls: string[] = []
  const layer = settingsCommands(settingsController(calls), NOOP, () => true)
  const names = commandNames(layer)

  for (const id of SETTINGS_ACTION_IDS) assert.equal(names.includes(`${SETTINGS_PREFIX}${id}`), true, id)
  assert.equal(names.includes('settings.next-action'), true)
  assert.equal(names.includes('settings.previous-action'), true)
  assert.equal(names.includes('settings.edit'), false)
  assert.equal(names.includes('settings.positive'), false)
  assert.equal(names.includes('settings.danger'), false)

  await run(layer, `${SETTINGS_PREFIX}preset.open`)
  await run(layer, `${SETTINGS_PREFIX}extension.remove`)
  await run(layer, 'settings.next-action')
  await run(layer, 'settings.previous-action')

  assert.deepEqual(calls, [
    'action:preset.open',
    'action:extension.remove',
    'action-cursor:1',
    'action-cursor:-1',
  ])
})

test('registers exact operation commands plus universal action-cursor navigation', async () => {
  const calls: string[] = []
  const layer = operationsOverlayCommands(operationsController(calls), () => true)
  const names = commandNames(layer)

  for (const id of OPERATION_ACTION_IDS) assert.equal(names.includes(`${OPERATIONS_PREFIX}${id}`), true, id)
  assert.equal(names.includes('operations.next-action'), true)
  assert.equal(names.includes('operations.previous-action'), true)
  assert.equal(names.includes('operations.edit'), false)
  assert.equal(names.includes('operations.positive'), false)
  assert.equal(names.includes('operations.danger'), false)

  await run(layer, `${OPERATIONS_PREFIX}feedback.clear`)
  await run(layer, `${OPERATIONS_PREFIX}goal.edit`)
  await run(layer, 'operations.next-action')
  await run(layer, 'operations.previous-action')

  assert.deepEqual(calls, [
    'action:feedback.clear',
    'action:goal.edit',
    'action-cursor:1',
    'action-cursor:-1',
  ])
})
