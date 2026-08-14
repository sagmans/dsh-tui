import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { KeyEvent, Renderable } from '@opentui/core'
import type { CommandContext } from '@opentui/keymap'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type {
  ChatSnapshot,
  ConversationPromptSnapshot,
  ConversationSnapshot,
  ConversationViewSnapshotStore,
  ObservableSnapshot,
  RequestView,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  createTrajectoryController,
  type TrajectoryControllerOptions,
  type TrajectoryListState,
} from '../../src/features/trajectory/model.js'
import { trajectoryCommands } from '../../src/features/trajectory/index.js'
import type { TuiTrajectoryRuntimeSnapshot } from '../../src/client/trajectory.js'
import { createNavigationStore } from '../../src/kernel/navigation.js'

// Static identities cross Harness brand boundaries only inside fixtures.
/* oxlint-disable typescript/no-unsafe-type-assertion */
const SESSION_ID = 'trajectory-session' as SessionId
const NEXT_SESSION_ID = 'trajectory-next' as SessionId
const RETRY_ID = 'trajectory-retry' as Extract<ConversationSnapshot['nodes'][number], { kind: 'model-retry' }>['retryId']
/* oxlint-enable typescript/no-unsafe-type-assertion */
const FIRST_TURN = 1
const SECOND_TURN = 2
const FIRST_STEP = 1
const SECOND_STEP = 2
const BASE_TIME = 1_000
const LARGE_RECORD_COUNT = 10_000
const AUTH_SENSITIVE_DETAIL = 'sensitive-auth-detail'
const AUTH_SAFE_MESSAGE = 'API key is invalid'
const RETRY_NODE_SEQ = 12
const RETRY_NODE_TIME = BASE_TIME + 1_200
const RECORD_SEQUENCE_SCALE = 1_000
const FIRST_RUNNING_CALL_ID = 'call-a'
const RUNNING_CHILD_CALL_ID = 'call-a-child'
const SECOND_RUNNING_CALL_ID = 'call-b'
// Command handlers do not consume target context in this fixture.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const COMMAND_CONTEXT = Object.freeze({}) as unknown as CommandContext<Renderable, KeyEvent>
const EMPTY_CHAT: ChatSnapshot = {
  order: [],
  nodes: { get: () => undefined, values: () => [] },
  locations: { getTurn: () => [], getStep: () => [] },
  timeline: { turnOrder: [], turns: new Map() },
  legacy: { nodes: [], turnTimings: new Map(), turnEnds: new Map(), partial: null, runningCalls: [] },
}

interface MutableSource<T> extends ObservableSnapshot<T> {
  publish(next: T): void
}

function source<T>(initial: T): MutableSource<T> {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => current,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    publish(next) {
      current = next
      for (const listener of listeners) listener()
    },
  }
}

function conversation(): ConversationSnapshot {
  return {
    sessionId: SESSION_ID,
    views: { get: () => undefined },
    chat: EMPTY_CHAT,
    nodes: [
      {
        kind: 'user',
        seq: 1,
        time: BASE_TIME,
        content: [{ type: 'text', text: 'Investigate cache misses' }],
        source: { kind: 'user' },
      },
      {
        kind: 'assistant',
        seq: 4,
        time: BASE_TIME + 400,
        turn: FIRST_TURN,
        step: FIRST_STEP,
        blocks: [
          { kind: 'reasoning', text: 'Inspect the cache key' },
          { kind: 'tool-call', callId: 'call-root', name: 'read_cache', argsRaw: '{"key":"alpha"}' },
        ],
        usage: {
          inputTokens: 20,
          outputTokens: 8,
          cacheReadTokens: 5,
          reasoningTokens: 3,
        },
        provenance: { provider: 'deepseek', model: 'reasoner' },
        requestConfig: { provider: 'deepseek', model: 'reasoner', maxTokens: 200 },
        timing: {
          stepStartTime: BASE_TIME + 100,
          firstTokenTime: BASE_TIME + 220,
          completedTime: BASE_TIME + 400,
        },
      },
      {
        kind: 'tool-result',
        seq: 5,
        time: BASE_TIME + 700,
        callId: 'call-root',
        call: { name: 'read_cache', argsRaw: '{"key":"alpha"}' },
        callTime: BASE_TIME + 410,
        content: [{ type: 'text', text: 'cache payload needle-detail' }],
        isError: false,
        callView: null,
        resultView: null,
        subCalls: [{
          callId: 'call-child',
          name: 'read_disk',
          argsRaw: '{"path":"/tmp/cache"}',
          turn: FIRST_TURN,
          step: FIRST_STEP,
          time: BASE_TIME + 500,
          callView: null,
          subCalls: [],
        }],
      },
      {
        kind: 'assistant',
        seq: 7,
        time: BASE_TIME + 900,
        turn: FIRST_TURN,
        step: SECOND_STEP,
        blocks: [{ kind: 'text', text: 'Cache miss confirmed.' }],
        usage: { inputTokens: 10, outputTokens: 4 },
        timing: {
          stepStartTime: BASE_TIME + 800,
          firstTokenTime: BASE_TIME + 850,
          completedTime: BASE_TIME + 900,
        },
      },
      {
        kind: 'compaction',
        seq: 8,
        time: BASE_TIME + 950,
        summary: 'Earlier cache investigation',
        summaryEventSeq: 6,
        shadowedItemCount: 2,
        shadowedTokenCount: 12,
      },
      {
        kind: 'user',
        seq: 9,
        time: BASE_TIME + 1_000,
        content: [{ type: 'text', text: 'Fix it' }],
        source: { kind: 'user' },
      },
      {
        kind: 'turn-error',
        seq: 10,
        time: BASE_TIME + 1_100,
        turn: SECOND_TURN,
        step: FIRST_STEP,
        message: 'Provider unavailable',
        code: 'provider-down',
      },
    ],
    turnTimings: new Map([
      [FIRST_TURN, { startTime: BASE_TIME + 50, endTime: BASE_TIME + 960 }],
      [SECOND_TURN, { startTime: BASE_TIME + 1_050, endTime: BASE_TIME + 1_100 }],
    ]),
    turnEnds: new Map([[FIRST_TURN, 8], [SECOND_TURN, 10]]),
    partial: null,
    runningCalls: [{
      callId: 'call-running',
      name: 'wait_for_cache',
      argsRaw: '{}',
      turn: SECOND_TURN,
      step: FIRST_STEP,
      time: BASE_TIME + 1_080,
      callView: null,
      subCalls: [],
    }],
    pending: [],
    queue: [],
    running: true,
    subagent: null,
    composerPhase: 'active',
    removed: false,
    openState: 'open',
    openError: null,
    hasMore: true,
    loadingOlder: false,
    promptError: null,
    blank: false,
    lastAgentError: null,
  }
}

function withRuntimeTrajectory(snapshot: ConversationSnapshot): ConversationSnapshot {
  // Fixture supplies a private target without globally widening Runtime's public target map.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const tools = [{
    name: 'read_cache',
    description: 'Read one cache entry',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } } },
  }] as unknown as ConversationPromptSnapshot['tools']
  const prompt: ConversationPromptSnapshot = {
    config: { provider: 'deepseek', model: 'reasoner', maxTokens: 200 },
    system: 'System diagnostic instructions',
    tools,
  }
  const requests: RequestView[] = [
    {
      purpose: 'assistant',
      startSeq: 2,
      startedAt: BASE_TIME + 100,
      completedAt: BASE_TIME + 400,
      status: 'complete',
      resultSeq: 4,
      turn: FIRST_TURN,
      step: FIRST_STEP,
      prompt,
      promptChange: { kind: 'initial', seq: 2, time: BASE_TIME + 90 },
      usage: { inputTokens: 20, outputTokens: 8, cacheReadTokens: 5, reasoningTokens: 3 },
    },
    {
      purpose: 'compaction',
      startSeq: 6,
      startedAt: BASE_TIME + 920,
      completedAt: BASE_TIME + 950,
      status: 'complete',
      resultSeq: 6,
      replacementSeq: 8,
      turn: FIRST_TURN,
      step: 0,
      rawOutput: [{ type: 'text', text: 'Complete compaction diagnostic output' }],
      summary: [{ type: 'text', text: 'Earlier cache investigation' }],
      usage: { inputTokens: 4, outputTokens: 2 },
    },
    {
      purpose: 'assistant',
      startSeq: 11,
      startedAt: BASE_TIME + 1_120,
      completedAt: null,
      status: 'running',
      turn: SECOND_TURN,
      step: SECOND_STEP,
      prompt,
    },
  ]
  const runtime: TuiTrajectoryRuntimeSnapshot = {
    headers: [{
      change: { kind: 'initial', seq: 2, time: BASE_TIME + 90 },
      location: { kind: 'unresolved' },
      prompt,
      seq: 2,
      time: BASE_TIME + 90,
    }],
    requests,
  }
  const views = {
    get: (target: string): unknown => target === 'tui-trajectory' ? runtime : snapshot.views.get('tui'),
  }
  return {
    ...snapshot,
    // Runtime target is intentionally private to the terminal plugin.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    views: views as unknown as ConversationViewSnapshotStore,
  }
}

function fixture() {
  const calls: string[] = []
  const binding = source(conversation())
  const list = source<TrajectoryListState>({ current: SESSION_ID })
  const navigation = createNavigationStore()
  const options: TrajectoryControllerOptions = {
    navigation,
    sessions: {
      list,
      binding: id => id === SESSION_ID
        ? {
            getSnapshot: () => binding.getSnapshot(),
            subscribe: listener => binding.subscribe(listener),
            loadOlder: () => { calls.push('older'); return Promise.resolve() },
          }
        : undefined,
    },
  }
  return {
    binding,
    calls,
    controller: createTrajectoryController(options),
    list,
    navigation,
  }
}

function rowKeys(snapshot: ReturnType<ReturnType<typeof fixture>['controller']['getSnapshot']>): readonly string[] {
  return snapshot.rows.map(row => row.key)
}

test('projects a turn and step ledger with nested tools, totals, and complete details', async () => {
  const { controller, navigation } = fixture()

  await controller.open()
  const snapshot = controller.getSnapshot()

  assert.equal(navigation.getSnapshot().overlays.at(-1)?.id, 'trajectory')
  assert.deepEqual(rowKeys(snapshot), [
    'turn:1',
    'record:user:1',
    'step:1:1',
    'record:assistant:4',
    'record:tool:call-root',
    'record:subtool:call-child',
    'step:1:2',
    'record:assistant:7',
    'record:compaction:8',
    'turn:2',
    'record:user:9',
    'step:2:1',
    'record:turn-error:10',
    'record:tool:call-running',
  ])
  assert.deepEqual(snapshot.aggregate, {
    cacheReadTokens: 5,
    cacheWriteTokens: 0,
    durationMs: 960,
    inputTokens: 30,
    outputTokens: 12,
    reasoningTokens: 3,
    records: 9,
    steps: 3,
    turns: 2,
  })

  const assistantIndex = snapshot.rows.findIndex(row => row.key === 'record:assistant:4')
  controller.selectRow(assistantIndex)
  assert.match(controller.getSnapshot().details.input, /deepseek/u)
  assert.match(controller.getSnapshot().details.output, /Inspect the cache key/u)
  assert.match(controller.getSnapshot().details.timing, /TTFT 120 ms/u)
  assert.match(controller.getSnapshot().details.raw, /"maxTokens": 200/u)
})

test('retains request prompts, tool schemas, compaction output, and request-only lifecycle data', async () => {
  const { binding, controller } = fixture()
  binding.publish(withRuntimeTrajectory(binding.getSnapshot()))
  await controller.open()

  let snapshot = controller.getSnapshot()
  assert.equal(snapshot.rows.some(row => row.key === 'record:system:2'), true)
  assert.equal(snapshot.rows.some(row => row.key === 'record:assistant-request:11'), true)
  assert.deepEqual(snapshot.aggregate, {
    cacheReadTokens: 5,
    cacheWriteTokens: 0,
    durationMs: 960,
    inputTokens: 34,
    outputTokens: 14,
    reasoningTokens: 3,
    records: 11,
    steps: 4,
    turns: 2,
  })

  controller.selectRow(snapshot.rows.findIndex(row => row.key === 'record:assistant:4'))
  assert.match(controller.getSnapshot().details.input, /System diagnostic instructions/u)
  assert.match(controller.getSnapshot().details.input, /Read one cache entry/u)

  snapshot = controller.getSnapshot()
  controller.selectRow(snapshot.rows.findIndex(row => row.key === 'record:tool:call-root'))
  assert.match(controller.getSnapshot().details.input, /SCHEMA/u)
  assert.match(controller.getSnapshot().details.input, /inputSchema/u)

  snapshot = controller.getSnapshot()
  controller.selectRow(snapshot.rows.findIndex(row => row.key === 'record:compaction:8'))
  assert.match(controller.getSnapshot().details.output, /Complete compaction diagnostic output/u)
})

test('supports stable folding and full-detail search without making raw JSON primary', async () => {
  const { controller } = fixture()
  await controller.open()

  controller.selectRow(controller.getSnapshot().rows.findIndex(row => row.key === 'record:assistant:4'))
  controller.toggleFold()
  assert.equal(rowKeys(controller.getSnapshot()).includes('record:tool:call-root'), false)
  assert.equal(rowKeys(controller.getSnapshot()).includes('record:assistant:4'), true)

  controller.selectRow(controller.getSnapshot().rows.findIndex(row => row.key === 'turn:1'))
  controller.toggleFold()
  assert.deepEqual(rowKeys(controller.getSnapshot()).slice(0, 2), ['turn:1', 'turn:2'])

  controller.openSearch()
  controller.setSearchInput('needle-detail')
  controller.submitSearch()
  const searched = controller.getSnapshot()
  assert.equal(searched.query, 'needle-detail')
  assert.equal(searched.searchInput, undefined)
  assert.equal(rowKeys(searched).includes('record:tool:call-root'), true)
  assert.equal(searched.rows.some(row => row.kind === 'turn'), true)

  controller.clearSearch()
  assert.equal(controller.getSnapshot().query, '')
})

test('pages older history and preserves record selection by stable identity across prepends', async () => {
  const { binding, calls, controller } = fixture()
  await controller.open()
  const selectedKey = 'record:assistant:7'
  controller.selectRow(controller.getSnapshot().rows.findIndex(row => row.key === selectedKey))

  binding.publish({
    ...binding.getSnapshot(),
    nodes: [{
      kind: 'user',
      seq: 0,
      time: BASE_TIME - 100,
      content: [{ type: 'text', text: 'Earlier prompt' }],
      source: { kind: 'user' },
    }, ...binding.getSnapshot().nodes],
  })
  assert.equal(controller.getSnapshot().selectedKey, selectedKey)

  assert.equal(await controller.loadOlder(), true)
  assert.deepEqual(calls, ['older'])
  assert.equal(controller.getSnapshot().busy, false)
})

test('uses recorded chronology and never fabricates duration for running calls', async () => {
  const { controller } = fixture()
  await controller.open()

  const snapshot = controller.getSnapshot()
  const assistant = snapshot.timeline.spans.find(span => span.key === 'record:assistant:4')
  const settledTool = snapshot.timeline.spans.find(span => span.key === 'record:tool:call-root')
  const runningTool = snapshot.timeline.spans.find(span => span.key === 'record:tool:call-running')

  assert.deepEqual(assistant, {
    durationMs: 300,
    endTime: BASE_TIME + 400,
    key: 'record:assistant:4',
    kind: 'assistant',
    lane: 1,
    sequence: 4 * RECORD_SEQUENCE_SCALE,
    startTime: BASE_TIME + 100,
  })
  assert.equal(settledTool?.durationMs, 290)
  assert.equal(runningTool?.durationMs, undefined)
  assert.equal(runningTool?.endTime, undefined)

  controller.toggleTimelineMode()
  assert.equal(controller.getSnapshot().timeline.mode, 'time')
})

test('redacts credential-bearing auth failures from output and raw details', async () => {
  const { binding, controller } = fixture()
  binding.publish({
    ...binding.getSnapshot(),
    nodes: [...binding.getSnapshot().nodes, {
      kind: 'model-retry',
      seq: RETRY_NODE_SEQ,
      time: RETRY_NODE_TIME,
      retryId: RETRY_ID,
      turn: SECOND_TURN,
      step: FIRST_STEP,
      provider: 'deepseek',
      mode: 'normal',
      policyKey: 'default',
      retry: 1,
      maxRetries: 3,
      delayMs: 250,
      failure: { code: 'AUTH', message: AUTH_SENSITIVE_DETAIL },
      retryState: 'scheduled',
    }],
  })
  await controller.open()

  const retryIndex = controller.getSnapshot().rows.findIndex(row => row.key === `record:model-retry:${String(RETRY_NODE_SEQ)}`)
  controller.selectRow(retryIndex)
  const details = controller.getSnapshot().details

  assert.match(details.output, new RegExp(AUTH_SAFE_MESSAGE, 'u'))
  assert.doesNotMatch(details.output, new RegExp(AUTH_SENSITIVE_DETAIL, 'u'))
  assert.doesNotMatch(details.raw, new RegExp(AUTH_SENSITIVE_DETAIL, 'u'))
})

test('maps keyboard commands to ledger, search, detail, timing, and pagination actions', async () => {
  const { calls, controller } = fixture()
  await controller.open()
  const layer = trajectoryCommands(controller, () => true)
  const run = async (name: string): Promise<void> => {
    const command = layer.commands.find(candidate => candidate.name === name)
    assert.ok(command, name)
    await command.run(COMMAND_CONTEXT)
  }

  assert.ok(layer.bindings.some(binding => binding.key === '/' && binding.command === 'trajectory.search'))
  assert.ok(layer.bindings.some(binding => binding.key === 'pageup' && binding.command === 'trajectory.older'))
  assert.ok(layer.bindings.some(binding => binding.key === '4' && binding.command === 'trajectory.detail.raw'))

  await run('trajectory.search')
  assert.equal(controller.getSnapshot().searchInput, '')
  controller.cancelSearch()
  await run('trajectory.detail.output')
  assert.equal(controller.getSnapshot().detailTab, 'output')
  await run('trajectory.timeline')
  assert.equal(controller.getSnapshot().timeline.mode, 'time')
  await run('trajectory.older')
  assert.deepEqual(calls, ['older'])
})

test('keeps multiple running tool trees contiguous in dispatch order', async () => {
  const { binding, controller } = fixture()
  const runningCalls: ConversationSnapshot['runningCalls'] = [
    {
      callId: FIRST_RUNNING_CALL_ID,
      name: 'first_tool',
      argsRaw: '{}',
      turn: FIRST_TURN,
      step: FIRST_STEP,
      time: BASE_TIME,
      callView: null,
      subCalls: [{
        callId: RUNNING_CHILD_CALL_ID,
        name: 'nested_tool',
        argsRaw: '{}',
        turn: FIRST_TURN,
        step: FIRST_STEP,
        time: BASE_TIME + 1,
        callView: null,
        subCalls: [],
      }],
    },
    {
      callId: SECOND_RUNNING_CALL_ID,
      name: 'second_tool',
      argsRaw: '{}',
      turn: FIRST_TURN,
      step: FIRST_STEP,
      time: BASE_TIME + 2,
      callView: null,
      subCalls: [],
    },
  ]
  binding.publish({ ...binding.getSnapshot(), nodes: [], runningCalls })
  await controller.open()

  assert.deepEqual(
    rowKeys(controller.getSnapshot()).filter(key => key.startsWith('record:')),
    [
      `record:tool:${FIRST_RUNNING_CALL_ID}`,
      `record:subtool:${RUNNING_CHILD_CALL_ID}`,
      `record:tool:${SECOND_RUNNING_CALL_ID}`,
    ],
  )
})

test('bounds rendered rows while keeping large ledgers searchable and inspectable', async () => {
  const { binding, controller } = fixture()
  const nodes: ConversationSnapshot['nodes'] = Array.from({ length: LARGE_RECORD_COUNT }, (_, index) => ({
    kind: 'assistant',
    seq: index + 1,
    time: BASE_TIME + index,
    turn: index + 1,
    step: FIRST_STEP,
    blocks: [{ kind: 'text', text: `event-${String(index + 1)}` }],
  }))
  binding.publish({ ...binding.getSnapshot(), hasMore: false, nodes, runningCalls: [] })
  await controller.open()

  const snapshot = controller.getSnapshot()
  assert.equal(snapshot.aggregate.records, LARGE_RECORD_COUNT)
  assert.equal(snapshot.totalRows, LARGE_RECORD_COUNT * 3)
  assert.equal(snapshot.rows.length, 200)

  controller.openSearch()
  controller.setSearchInput(`event-${String(LARGE_RECORD_COUNT)}`)
  controller.submitSearch()
  assert.equal(controller.getSnapshot().totalRows, 3)
  assert.equal(controller.getSnapshot().rows.at(-1)?.key, `record:assistant:${String(LARGE_RECORD_COUNT)}`)
})

test('drops stale session updates and closes the ledger when active session changes', async () => {
  const { binding, controller, list, navigation } = fixture()
  await controller.open()

  list.publish({ current: NEXT_SESSION_ID })
  binding.publish({ ...binding.getSnapshot(), running: false })

  assert.equal(controller.getSnapshot().active, false)
  assert.equal(controller.getSnapshot().sessionId, NEXT_SESSION_ID)
  assert.equal(controller.getSnapshot().rows.length, 0)
  assert.equal(navigation.getSnapshot().overlays.length, 0)
})
