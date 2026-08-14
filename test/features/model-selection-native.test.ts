import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createTestRenderer } from '@opentui/core/testing'
import type {
  ModelSelectionController,
  ModelSelectionSnapshotView,
} from '../../src/features/model-selection/model.js'
import { createTuiTheme } from '../../src/services/theme.js'
import { createModelSelectionView } from '../../src/views/model-selection/root.js'

const NATIVE_RENDERER_AVAILABLE = process.versions.bun !== undefined
  || process.getBuiltinModule('node:ffi') !== undefined
const WIDTH = 72
const HEIGHT = 20
const NOOP = (): void => {}

function controller(calls: string[]): ModelSelectionController {
  let listener = NOOP
  const snapshot: ModelSelectionSnapshotView = {
    active: true,
    available: true,
    blocked: true,
    busy: false,
    currentLabel: 'Flash',
    effortLabel: 'High',
    entry: 'composer',
    error: undefined,
    overlayId: 'model-selection',
    pane: 'model',
    rowIndex: 0,
    routable: false,
    rows: [
      {
        details: 'DeepSeek · Fast',
        enabled: true,
        id: 'model:deepseek:flash',
        selected: true,
        title: 'Flash',
      },
      {
        details: 'DeepSeek',
        enabled: true,
        id: 'model:deepseek:pro',
        selected: false,
        title: 'Pro',
      },
    ],
    status: 'No provider can route the current model.',
  }
  return {
    activate: () => { calls.push('activate'); return Promise.resolve(true) },
    back: () => { calls.push('back') },
    close: () => { calls.push('close') },
    dispose: NOOP,
    getSnapshot: () => snapshot,
    move: delta => { calls.push(`move:${delta}`) },
    open: () => Promise.resolve(true),
    openProviders: () => { calls.push('providers') },
    refresh: () => { calls.push('refresh'); return Promise.resolve() },
    selectRow: index => { calls.push(`row:${index}`); listener() },
    subscribe: next => { listener = next; return () => { listener = NOOP } },
  }
}

test.skipIf(!NATIVE_RENDERER_AVAILABLE)('supports mouse model choice and provider recovery', async () => {
  const harness = await createTestRenderer({ width: WIDTH, height: HEIGHT, bufferedOutput: 'memory' })
  const calls: string[] = []
  const view = createModelSelectionView(harness.renderer, createTuiTheme({ color: true }), controller(calls))
  harness.renderer.root.add(view)

  try {
    await harness.flush()
    const frame = harness.captureCharFrame()
    assert.match(frame, /MODEL/u)
    assert.match(frame, /Flash/u)
    assert.match(frame, /Pro/u)
    assert.match(frame, /No provider can route/u)

    const model = view.findDescendantById('model-selection-row-1')
    assert.ok(model)
    await harness.mockMouse.click(model.screenX + 1, model.screenY)
    await harness.flush()
    const providers = view.findDescendantById('model-selection-providers')
    assert.ok(providers)
    await harness.mockMouse.click(providers.screenX + 1, providers.screenY)

    assert.deepEqual(calls, ['row:1', 'activate', 'providers'])
  } finally {
    view.destroyRecursively()
    harness.renderer.destroy()
  }
})
