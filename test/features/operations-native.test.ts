import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { KeyEvent, Renderable } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import type { CommandContext } from '@opentui/keymap'
import type {
  OperationActionId,
  OperationsController,
  OperationsSection,
} from '../../src/features/operations/model.js'
import { operationsOverlayCommands } from '../../src/features/operations/commands.js'
import { createTuiTheme } from '../../src/services/theme.js'
import { createOperationsView } from '../../src/views/operations/root.js'

const NATIVE_RENDERER_AVAILABLE = process.versions.bun !== undefined
  || process.getBuiltinModule('node:ffi') !== undefined
const WIDTH = 80
const HEIGHT = 24
const ACTION_IDS = Object.freeze(['goal.pause', 'goal.clear'] as const satisfies readonly OperationActionId[])
// Command actions ignore target context; this fixture preserves the keymap call signature.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const COMMAND_CONTEXT = Object.freeze({}) as unknown as CommandContext<Renderable, KeyEvent>

function controller(calls: string[]): OperationsController {
  return {
    cancelInput: () => {},
    close: () => {},
    dispose: () => {},
    getSnapshot: () => ({
      busy: false,
      confirmation: undefined,
      error: undefined,
      input: undefined,
      overlayId: 'operations',
      rowIndex: 0,
      rows: [{
        actions: [
          {
            command: 'operations.action.goal.pause',
            enabled: true,
            id: 'goal.pause',
            label: 'PAUSE',
            tone: 'default',
          },
          {
            command: 'operations.action.goal.clear',
            enabled: true,
            id: 'goal.clear',
            label: 'CLEAR',
            tone: 'danger',
          },
        ],
        details: 'Goal details',
        id: 'goal:one',
        state: 'running',
        summary: 'active',
        title: 'Ship safely',
      }],
      section: 'goal',
      sections: ['goal', 'plan', 'workflows', 'jobs', 'subagents', 'trajectory', 'feedback'],
      selectedActionId: 'goal.pause',
      status: '1/1',
    }),
    move: delta => { calls.push(`move:${delta}`) },
    moveAction: delta => { calls.push(`action-cursor:${delta}`) },
    moveSection: delta => { calls.push(`section:${delta}`) },
    open: () => Promise.resolve(),
    perform: (action?: OperationActionId) => { calls.push(`action:${action}`); return Promise.resolve(true) },
    selectRow: index => { calls.push(`row:${index}`) },
    selectSection: (section: OperationsSection) => { calls.push(`tab:${section}`) },
    setInput: () => {},
    submitInput: () => Promise.resolve(false),
    subscribe: () => () => {},
    toggle: () => Promise.resolve(),
  }
}

test.skipIf(!NATIVE_RENDERER_AVAILABLE)('routes exact operation actions through keyboard and mouse', async () => {
  const harness = await createTestRenderer({ width: WIDTH, height: HEIGHT, bufferedOutput: 'memory' })
  const calls: string[] = []
  const actionController = controller(calls)
  const view = createOperationsView(harness.renderer, createTuiTheme({ color: true }), actionController)
  const commands = operationsOverlayCommands(actionController, () => true)
  harness.renderer.root.add(view)

  try {
    await harness.flush()
    const frame = harness.captureCharFrame()
    assert.match(frame, /Ship safely/u)
    assert.match(frame, /PAUSE/u)
    assert.match(frame, /CLEAR/u)

    for (const id of ACTION_IDS) {
      const command = commands.commands.find(candidate => candidate.name === `operations.action.${id}`)
      assert.ok(command)
      await command.run(COMMAND_CONTEXT)
      const target = view.findDescendantById(`operations-action-${id}`)
      assert.ok(target)
      await harness.mockMouse.click(target.screenX + 1, target.screenY)
    }

    const row = view.findDescendantById('operations-row-0')
    const tab = view.findDescendantById('operations-tab-feedback')
    assert.ok(row)
    assert.ok(tab)
    await harness.mockMouse.click(row.screenX + 1, row.screenY)
    await harness.mockMouse.click(tab.screenX + 1, tab.screenY)

    assert.deepEqual(calls, [
      'action:goal.pause',
      'action:goal.pause',
      'action:goal.clear',
      'action:goal.clear',
      'row:0',
      'tab:feedback',
    ])
  } finally {
    view.destroyRecursively()
    harness.renderer.destroy()
  }
})
