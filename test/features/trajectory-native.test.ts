import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createTestRenderer } from '@opentui/core/testing'
import type {
  TrajectoryController,
  TrajectoryDetailTab,
  TrajectorySnapshotView,
} from '../../src/features/trajectory/model.js'
import { createTuiTheme } from '../../src/services/theme.js'
import { createTrajectoryView } from '../../src/views/trajectory/root.js'

const NATIVE_RENDERER_AVAILABLE = process.versions.bun !== undefined
  || process.getBuiltinModule('node:ffi') !== undefined
const WIDTH = 100
const HEIGHT = 30
const NOOP = (): void => {}

function controller(calls: string[]): TrajectoryController {
  let listener = NOOP
  let searchInput: string | undefined
  let inputValue = ''
  let detailTab: TrajectoryDetailTab = 'input'
  const publish = (): void => { listener() }
  const snapshot = (): TrajectorySnapshotView => ({
    active: true,
    aggregate: {
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      durationMs: 500,
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 3,
      records: 2,
      steps: 1,
      turns: 1,
    },
    busy: false,
    detailTab,
    details: {
      input: 'provider deepseek',
      output: 'complete output',
      raw: '{"kind":"assistant"}',
      timing: 'TTFT 100 ms',
    },
    error: undefined,
    hasMore: true,
    loadingOlder: false,
    overlayId: 'trajectory',
    query: '',
    rowIndex: 1,
    rows: [
      {
        collapsed: false,
        depth: 0,
        error: false,
        foldable: true,
        key: 'turn:1',
        kind: 'turn',
        label: 'Turn 1',
        preview: '',
        record: undefined,
        step: undefined,
        turn: 1,
      },
      {
        collapsed: false,
        depth: 2,
        error: false,
        foldable: true,
        key: 'record:assistant:2',
        kind: 'record',
        label: 'Assistant · step 1',
        preview: 'complete output',
        record: {
          depth: 0,
          durationMs: 300,
          error: false,
          key: 'record:assistant:2',
          kind: 'assistant',
          label: 'Assistant · step 1',
          preview: 'complete output',
          seq: 2,
          startedAt: 1_000,
          step: 1,
          tokens: {
            cacheReadTokens: 2,
            cacheWriteTokens: 1,
            inputTokens: 10,
            outputTokens: 5,
            reasoningTokens: 3,
          },
          turn: 1,
        },
        step: 1,
        turn: 1,
      },
    ],
    searchInput,
    selectedKey: 'record:assistant:2',
    sessionId: undefined,
    status: '2/2',
    timeline: {
      mode: 'sequence',
      spans: [{
        durationMs: 300,
        endTime: 1_300,
        key: 'record:assistant:2',
        kind: 'assistant',
        lane: 1,
        sequence: 2_000,
        startTime: 1_000,
      }],
    },
    totalRows: 2,
    windowStart: 0,
  })
  return {
    cancelSearch: () => { calls.push('search:cancel'); searchInput = undefined; publish() },
    clearSearch: () => { calls.push('search:clear') },
    close: () => { calls.push('close') },
    dispose: NOOP,
    getSnapshot: snapshot,
    loadOlder: () => { calls.push('older'); return Promise.resolve(true) },
    move: delta => { calls.push(`move:${String(delta)}`) },
    moveDetailTab: delta => { calls.push(`tab-move:${String(delta)}`) },
    open: () => Promise.resolve(),
    openSearch: () => { calls.push('search:open'); searchInput = ''; inputValue = ''; publish() },
    selectDetailTab: tab => { calls.push(`tab:${tab}`); detailTab = tab; publish() },
    selectRow: index => { calls.push(`row:${String(index)}`) },
    setSearchInput: value => { inputValue = value },
    submitSearch: () => { calls.push(`search:save:${inputValue}`); searchInput = undefined; publish() },
    subscribe: next => { listener = next; return () => { listener = NOOP } },
    toggleFold: () => { calls.push('fold') },
    toggleTimelineMode: () => { calls.push('timeline') },
  }
}

async function click(view: ReturnType<typeof createTrajectoryView>, harness: Awaited<ReturnType<typeof createTestRenderer>>, id: string): Promise<void> {
  const target = view.findDescendantById(id)
  assert.ok(target, id)
  await harness.mockMouse.click(target.screenX + 1, target.screenY)
  await harness.flush()
}

test.skipIf(!NATIVE_RENDERER_AVAILABLE)('supports mouse ledger, fold, search, pagination, timeline, and detail tabs', async () => {
  const harness = await createTestRenderer({ width: WIDTH, height: HEIGHT, bufferedOutput: 'memory' })
  const calls: string[] = []
  const view = createTrajectoryView(harness.renderer, createTuiTheme({ color: true }), controller(calls))
  harness.renderer.root.add(view)

  try {
    await harness.flush()
    const frame = harness.captureCharFrame()
    assert.match(frame, /TRAJECTORY/u)
    assert.match(frame, /Assistant/u)
    assert.match(frame, /in 10 · out 5/u)

    await click(view, harness, 'trajectory-row-0')
    await click(view, harness, 'trajectory-fold-1')
    await click(view, harness, 'trajectory-detail-output')
    await click(view, harness, 'trajectory-timeline-mode')
    await click(view, harness, 'trajectory-load-older')
    await click(view, harness, 'trajectory-search')

    const input = view.findDescendantById('trajectory-search-input')
    assert.ok(input)
    await harness.mockMouse.click(input.screenX + 1, input.screenY)
    await harness.mockInput.typeText('needle')
    await click(view, harness, 'trajectory-search-input-save')
    await click(view, harness, 'trajectory-close')

    assert.deepEqual(calls, [
      'row:0',
      'row:1',
      'fold',
      'tab:output',
      'timeline',
      'older',
      'search:open',
      'search:save:needle',
      'close',
    ])
  } finally {
    view.destroyRecursively()
    harness.renderer.destroy()
  }
})
