import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createTestRenderer } from '@opentui/core/testing'
import type {
  OperationActionId,
  OperationsController,
  OperationsSection,
} from '../../src/features/operations/model.js'
import { createTuiTheme } from '../../src/services/theme.js'
import { createOperationsView } from '../../src/views/operations/root.js'

const NATIVE_RENDERER_AVAILABLE = process.versions.bun !== undefined
  || process.getBuiltinModule('node:ffi') !== undefined
const WIDTH = 80
const HEIGHT = 24

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
        actions: [{ id: 'goal.pause', label: 'PAUSE', tone: 'default' }],
        details: 'Goal details',
        id: 'goal:one',
        state: 'running',
        summary: 'active',
        title: 'Ship safely',
      }],
      section: 'goal',
      sections: ['goal', 'plan', 'workflows', 'jobs', 'subagents', 'trajectory', 'feedback'],
      status: '1/1',
    }),
    move: delta => { calls.push(`move:${delta}`) },
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

test.skipIf(!NATIVE_RENDERER_AVAILABLE)('supports mouse tabs, rows, and operational actions', async () => {
  const harness = await createTestRenderer({ width: WIDTH, height: HEIGHT, bufferedOutput: 'memory' })
  const calls: string[] = []
  const view = createOperationsView(harness.renderer, createTuiTheme({ color: true }), controller(calls))
  harness.renderer.root.add(view)

  try {
    await harness.flush()
    const frame = harness.captureCharFrame()
    assert.match(frame, /Ship safely/u)
    assert.match(frame, /PAUSE/u)
    for (const id of ['operations-action-goal.pause', 'operations-row-0', 'operations-tab-feedback']) {
      const target = view.findDescendantById(id)
      assert.ok(target)
      await harness.mockMouse.click(target.screenX + 1, target.screenY)
    }
    assert.deepEqual(calls, ['action:goal.pause', 'row:0', 'tab:feedback'])
  } finally {
    view.destroyRecursively()
    harness.renderer.destroy()
  }
})
