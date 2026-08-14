import assert from 'node:assert/strict'
import { test } from 'vitest'
import type {
  ConversationMatch,
  ConversationNodeContext,
  ConversationNodeDefinition,
  ConversationViewNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  tuiTrajectoryAssistantDefinition,
  tuiTrajectoryCompactionDefinition,
  tuiTrajectoryHeaderDefinition,
  tuiTrajectorySessionEndDefinition,
  tuiTrajectoryViewDefinition,
} from '../../src/client/trajectory.js'

const HEADER_SEQ = 1
const START_SEQ = 2
const SUMMARY_SEQ = 4
const END_SEQ = 5
const TURN = 1
const STEP = 1
const HEADER_TIME = 100
const START_TIME = 110
const SUMMARY_TIME = 150
const END_TIME = 160
const FIRST_USAGE_SEQ = 3
const FIRST_USAGE_TIME = 120
const RETRY_SEQ = 4
const RETRY_TIME = 130
const SECOND_USAGE_SEQ = 5
const SECOND_USAGE_TIME = 140
const FINAL_SEQ = 6
const FINAL_TIME = 170
const RETRY_COUNT = 1
const MAX_RETRIES = 3
const RETRY_DELAY_MS = 250
const REDACTED_AUTH_MESSAGE = 'API key is invalid'

type Event = Parameters<ConversationNodeDefinition['match']>[0]

function match(event: Event, role: ConversationMatch['role']): ConversationMatch {
  return { event, role, view: undefined, location: { kind: 'unresolved' } }
}

function context<State>(
  definition: ConversationNodeDefinition<State>,
  matches: readonly ConversationMatch[],
  state?: State,
): ConversationNodeContext<State> {
  return {
    current: new Map(),
    id: 'fixture',
    key: `${definition.kind}:fixture`,
    kind: definition.kind,
    matches,
    start: matches[0],
    state,
  }
}

function nodeOf<State>(
  definition: ConversationNodeDefinition<State>,
  matches: readonly ConversationMatch[],
  state: State,
): ConversationViewNode {
  const node = definition.buildViewNode?.(context(definition, matches, state))
  assert.ok(node)
  return node
}

test('assembles request headers into running assistant request inspection', () => {
  const headerEvent: Event = {
    type: 'request/header',
    seq: HEADER_SEQ,
    time: HEADER_TIME,
    data: {
      reason: 'initial',
      header: {
        config: { provider: 'deepseek', model: 'reasoner' },
        system: 'System prompt',
        tools: [],
      },
    },
  }
  const startEvent: Event = {
    type: 'step/start',
    seq: START_SEQ,
    time: START_TIME,
    data: { turn: TURN, step: STEP },
  }
  const headerMatch = match(headerEvent, 'start')
  const startMatch = match(startEvent, 'start')
  const headerState = tuiTrajectoryHeaderDefinition.start(
    context(tuiTrajectoryHeaderDefinition, [headerMatch]),
    headerMatch,
    { previous: () => undefined },
  )
  const assistantState = tuiTrajectoryAssistantDefinition.start(
    context(tuiTrajectoryAssistantDefinition, [startMatch]),
    startMatch,
    { previous: () => undefined },
  )
  const builder = tuiTrajectoryViewDefinition.create()
  const nodes = [
    nodeOf(tuiTrajectoryHeaderDefinition, [headerMatch], headerState),
    nodeOf(tuiTrajectoryAssistantDefinition, [startMatch], assistantState),
  ]
  // Definitions and target factory share one private node envelope.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const snapshot = builder.replace({ nodes: nodes as never, timeline: { turnOrder: [], turns: new Map() } })

  assert.equal(snapshot.headers[0]?.prompt.system, 'System prompt')
  assert.equal(snapshot.requests[0]?.purpose, 'assistant')
  assert.equal(snapshot.requests[0]?.status, 'running')
  assert.equal(snapshot.requests[0]?.requestConfig?.model, 'reasoner')
  assert.equal(snapshot.requests[0]?.purpose === 'assistant' ? snapshot.requests[0].prompt?.system : undefined, 'System prompt')
})

test('accumulates retry usage, redacts auth failures, and recovers on final output', () => {
  // Dynamic host-event fixtures cross the runtime's merge-extensible event boundary.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const events = [
    {
      type: 'step/start',
      seq: START_SEQ,
      time: START_TIME,
      data: { turn: TURN, step: STEP },
    },
    {
      type: 'assistant/chunk',
      seq: FIRST_USAGE_SEQ,
      time: FIRST_USAGE_TIME,
      data: { turn: TURN, step: STEP, chunk: { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } } },
    },
    {
      type: 'llm/retry',
      seq: RETRY_SEQ,
      time: RETRY_TIME,
      data: {
        retryId: 'retry-one',
        turn: TURN,
        step: STEP,
        provider: 'deepseek',
        mode: 'normal',
        policyKey: 'default',
        retry: RETRY_COUNT,
        maxRetries: MAX_RETRIES,
        delayMs: RETRY_DELAY_MS,
        failure: { code: 'AUTH', message: 'credential-fragment' },
      },
    },
    {
      type: 'assistant/chunk',
      seq: SECOND_USAGE_SEQ,
      time: SECOND_USAGE_TIME,
      data: { turn: TURN, step: STEP, chunk: { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } } },
    },
    {
      type: 'assistant/message',
      seq: FINAL_SEQ,
      time: FINAL_TIME,
      surfaceOp: 'append',
      data: {
        turn: TURN,
        step: STEP,
        message: {
          id: 'assistant-one',
          content: [{ type: 'text', text: 'Recovered' }],
          source: { provider: 'deepseek', model: 'reasoner' },
        },
        usage: { inputTokens: 999, outputTokens: 999 },
      },
    },
  ] as unknown as readonly Event[]
  const matches = events.map((event, index) => match(event, index === 0 ? 'start' : 'update'))
  const firstMatch = matches[0]
  assert.ok(firstMatch)
  let state = tuiTrajectoryAssistantDefinition.start(
    context(tuiTrajectoryAssistantDefinition, matches),
    firstMatch,
    { previous: () => undefined },
  )
  for (const next of matches.slice(1)) {
    state = tuiTrajectoryAssistantDefinition.update(
      { ...context(tuiTrajectoryAssistantDefinition, matches, state), state },
      next,
    )
  }
  const builder = tuiTrajectoryViewDefinition.create()
  const node = nodeOf(tuiTrajectoryAssistantDefinition, matches, state)
  // Definition and target factory share one private node envelope.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const snapshot = builder.replace({ nodes: [node] as never, timeline: { turnOrder: [], turns: new Map() } })
  const request = snapshot.requests[0]

  assert.equal(request?.purpose, 'assistant')
  assert.equal(request?.status, 'complete')
  assert.equal(request?.error, REDACTED_AUTH_MESSAGE)
  assert.equal(request?.purpose === 'assistant' ? request.maxRetries : undefined, MAX_RETRIES)
  assert.deepEqual(request?.usage, { inputTokens: 12, outputTokens: 5 })
})

test('marks running compaction requests interrupted at session boundaries', () => {
  // Compaction declarations are contributed by the host profile.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const startEvent = {
    type: 'compaction/start',
    seq: START_SEQ,
    time: START_TIME,
    data: { compactionId: 'compact-interrupted', turn: TURN },
  } as unknown as Event
  // Session boundaries are contributed by the host agent profile.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const boundaryEvent = {
    type: 'session/end-seed',
    seq: END_SEQ,
    time: END_TIME,
    data: {},
  } as unknown as Event
  const startMatch = match(startEvent, 'start')
  const boundaryMatch = match(boundaryEvent, 'start')
  const compactionState = tuiTrajectoryCompactionDefinition.start(
    context(tuiTrajectoryCompactionDefinition, [startMatch]),
    startMatch,
    { previous: () => undefined },
  )
  const boundaryState = tuiTrajectorySessionEndDefinition.start(
    context(tuiTrajectorySessionEndDefinition, [boundaryMatch]),
    boundaryMatch,
    { previous: () => undefined },
  )
  const builder = tuiTrajectoryViewDefinition.create()
  const nodes = [
    nodeOf(tuiTrajectoryCompactionDefinition, [startMatch], compactionState),
    nodeOf(tuiTrajectorySessionEndDefinition, [boundaryMatch], boundaryState),
  ]
  // Definitions and target factory share one private node envelope.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const snapshot = builder.replace({ nodes: nodes as never, timeline: { turnOrder: [], turns: new Map() } })
  const request = snapshot.requests[0]

  assert.equal(request?.purpose, 'compaction')
  assert.equal(request?.status, 'error')
  assert.equal(request?.completedAt, END_TIME)
  assert.equal(request?.error, 'Compaction was interrupted before completion.')
})

test('retains complete compaction output and usage from dynamically contributed events', () => {
  // Compaction event declarations are supplied by the host preset graph at runtime.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const startEvent = {
    type: 'compaction/start',
    seq: START_SEQ,
    time: START_TIME,
    data: { compactionId: 'compact-one', turn: TURN },
  } as unknown as Event
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const summaryEvent = {
    type: 'compaction/summary',
    seq: SUMMARY_SEQ,
    time: SUMMARY_TIME,
    data: {
      compactionId: 'compact-one',
      summary: [{ type: 'text', text: 'Safe summary' }],
      rawOutput: [{ type: 'text', text: 'Complete provider output' }],
      provider: 'deepseek',
      model: 'reasoner',
      usage: { inputTokens: 12, outputTokens: 3 },
    },
  } as unknown as Event
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const endEvent = {
    type: 'compaction/end',
    seq: END_SEQ,
    time: END_TIME,
    data: { compactionId: 'compact-one' },
  } as unknown as Event
  const startMatch = match(startEvent, 'start')
  const summaryMatch = match(summaryEvent, 'update')
  const endMatch = match(endEvent, 'update')
  const initial = tuiTrajectoryCompactionDefinition.start(
    context(tuiTrajectoryCompactionDefinition, [startMatch]),
    startMatch,
    { previous: () => undefined },
  )
  const summarized = tuiTrajectoryCompactionDefinition.update(
    { ...context(tuiTrajectoryCompactionDefinition, [startMatch, summaryMatch], initial), state: initial },
    summaryMatch,
  )
  const completed = tuiTrajectoryCompactionDefinition.update(
    { ...context(tuiTrajectoryCompactionDefinition, [startMatch, summaryMatch, endMatch], summarized), state: summarized },
    endMatch,
  )
  const builder = tuiTrajectoryViewDefinition.create()
  const node = nodeOf(
    tuiTrajectoryCompactionDefinition,
    [startMatch, summaryMatch, endMatch],
    completed,
  )
  // Definition and target factory share one private node envelope.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const snapshot = builder.replace({ nodes: [node] as never, timeline: { turnOrder: [], turns: new Map() } })
  const request = snapshot.requests[0]

  assert.equal(request?.purpose, 'compaction')
  assert.equal(request?.status, 'complete')
  assert.deepEqual(request?.usage, { inputTokens: 12, outputTokens: 3 })
  assert.deepEqual(request?.purpose === 'compaction' ? request.rawOutput : undefined, [{
    type: 'text',
    text: 'Complete provider output',
  }])
})
