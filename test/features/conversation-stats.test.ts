import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ChatSnapshot,
  ConversationNode,
  ConversationSnapshot,
  ConversationViewSnapshotStore,
  ObservableSnapshot,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  createConversationController,
  type ConversationProjectionKey,
  type ConversationSessionBinding,
} from '../../src/features/conversation/model.js'

const SESSION_TITLE = 'Projected conversation'
const COMPACTION_SUMMARY = 'Keep the verified implementation decisions.'
const RETRY_MESSAGE = 'provider temporarily unavailable'
const BLOCKED_REASON = 'Waiting for approval'
const MALICIOUS_OBJECTIVE = 'Ship\u001B[31m safely'
const SAFE_OBJECTIVE = 'Ship safely'
const COMPACT_COMMAND = '/compact'
const PLAN_OFF_COMMAND = '/plan off'
// Static fixture identities cross only Harness brand boundaries.
/* oxlint-disable typescript/no-unsafe-type-assertion */
const SESSION_ID = 'conversation-stats-session' as SessionId
const RETRY_ID = 'conversation-retry' as never
/* oxlint-enable typescript/no-unsafe-type-assertion */
const EMPTY_VIEWS: ConversationViewSnapshotStore = { get: () => undefined }
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

function lifecycleNodes(): readonly ConversationNode[] {
  return [
    {
      kind: 'compaction',
      seq: 20,
      time: 20,
      summary: COMPACTION_SUMMARY,
      summaryEventSeq: 19,
      shadowedItemCount: 8,
      shadowedTokenCount: 2_400,
    },
    {
      kind: 'model-retry',
      seq: 21,
      time: 21,
      retryId: RETRY_ID,
      turn: 3,
      step: 2,
      provider: 'deepseek',
      mode: 'normal',
      policyKey: 'default',
      retry: 2,
      maxRetries: 4,
      delayMs: 1_500,
      failure: { code: 'upstream-busy', message: RETRY_MESSAGE },
      retryState: 'scheduled',
    },
  ]
}

function snapshot(): ConversationSnapshot {
  const nodes = lifecycleNodes()
  return {
    sessionId: SESSION_ID,
    views: EMPTY_VIEWS,
    chat: { ...EMPTY_CHAT, legacy: { ...EMPTY_CHAT.legacy, nodes } },
    nodes,
    turnTimings: new Map(),
    turnEnds: new Map(),
    partial: null,
    runningCalls: [],
    pending: [],
    queue: [],
    running: true,
    subagent: null,
    composerPhase: 'active',
    removed: false,
    openState: 'open',
    openError: null,
    hasMore: false,
    loadingOlder: false,
    promptError: null,
    blank: false,
    lastAgentError: null,
  }
}

function projections(): Record<ConversationProjectionKey, MutableSource<unknown>> {
  return {
    sessionStats: source({
      turns: 4,
      steps: 6,
      llmMs: 12_000,
      toolMs: 3_000,
      ttftMs: 1_200,
      ttftSteps: 3,
      decodeMs: 4_000,
      decodeTokens: 200,
    }),
    tokenUsage: source({
      uncachedInputTokens: 1_000,
      cacheReadTokens: 500,
      cacheWriteTokens: 100,
      outputTokens: 200,
    }),
    contextPressure: source({ pressureTokens: 5_500, projectedTokens: 6_000, contextWindow: 8_000 }),
    contextBreakdown: source({ systemTokens: 500, toolsTokens: 750, messageTokens: 2_500 }),
    todos: source([
      { content: 'Inspect projections', status: 'completed' },
      { content: 'Render seats', status: 'in_progress' },
      { content: 'Dogfood flow', status: 'pending' },
    ]),
    plan: source({ active: false, pending: true }),
    goal: source({
      goal: {
        id: 'goal-one',
        revision: 2,
        objective: MALICIOUS_OBJECTIVE,
        phase: 'blocked',
        blockedReason: { code: 'approval', message: BLOCKED_REASON },
        maxGoalRounds: 5,
      },
      roundsStarted: 2,
      createdAt: 1,
      updatedAt: 2,
    }),
  }
}

function fixture(): {
  readonly commands: string[]
  readonly controller: ReturnType<typeof createConversationController>
  readonly projectionFaces: Record<ConversationProjectionKey, MutableSource<unknown>>
} {
  const projectionFaces = projections()
  const commands: string[] = []
  const session = source(snapshot())
  const binding: ConversationSessionBinding = {
    ...session,
    cancel: () => Promise.resolve(),
    command: (line) => { commands.push(line); return Promise.resolve(line === COMPACT_COMMAND || line === PLAN_OFF_COMMAND) },
    loadOlder: () => Promise.resolve(),
    projection: key => projectionFaces[key],
    prompt: () => Promise.resolve(),
    updateQueue: () => Promise.resolve({ ok: true, value: { accepted: true } }),
  }
  return {
    commands,
    controller: createConversationController({
      sessions: {
        list: source({ current: SESSION_ID, byId: { [SESSION_ID]: { displayTitle: SESSION_TITLE } } }),
        binding: () => binding,
      },
    }),
    projectionFaces,
  }
}

test('projects authoritative whole-log statistics, context, work state, and lifecycle details', () => {
  const { controller } = fixture()
  const view = controller.getSnapshot()

  assert.deepEqual(view.statistics, {
    timing: {
      turns: 4,
      steps: 6,
      llmMs: 12_000,
      toolMs: 3_000,
      ttftAverageMs: 400,
      tokensPerSecond: 50,
    },
    tokens: {
      billedInputTokens: 1_600,
      outputTokens: 200,
      cacheHitPercent: 31,
    },
  })
  assert.deepEqual(view.context, {
    percent: 75,
    usedTokens: 6_000,
    contextWindow: 8_000,
    breakdown: { systemTokens: 500, toolsTokens: 750, messageTokens: 2_500 },
  })
  assert.deepEqual(view.todos.map(todo => todo.status), ['completed', 'in_progress', 'pending'])
  assert.deepEqual(view.plan, { active: false, pending: true, effective: true })
  assert.equal(view.goal?.objective, SAFE_OBJECTIVE)
  assert.equal(view.goal?.blockedReason, BLOCKED_REASON)
  assert.deepEqual(view.lifecycle.map(item => item.kind), ['compaction', 'retry'])
  assert.match(view.lifecycle[0]?.details ?? '', /8 items.*2\.4K tokens.*verified implementation/su)
  assert.match(view.lifecycle[1]?.details ?? '', /deepseek.*2\/4.*1\.5s.*upstream-busy.*temporarily unavailable/su)
})

test('reacts to exact projection faces without replacing session truth', async () => {
  const { controller, projectionFaces } = fixture()
  let notifications = 0
  controller.subscribe(() => { notifications += 1 })

  projectionFaces.contextPressure.publish({ projectedTokens: 2_000, contextWindow: 8_000 })
  projectionFaces.sessionStats.publish({
    turns: 5,
    steps: 7,
    llmMs: 15_000,
    toolMs: 4_000,
    ttftMs: 1_500,
    ttftSteps: 3,
    decodeMs: 5_000,
    decodeTokens: 300,
  })
  await Promise.resolve()

  assert.equal(notifications, 1)
  assert.equal(controller.getSnapshot().context?.percent, 25)
  assert.equal(controller.getSnapshot().statistics?.timing?.turns, 5)
})

test('opens information sections and invokes plan exit and compaction through session commands', async () => {
  const { commands, controller } = fixture()

  controller.openInformation('context')
  assert.equal(controller.getSnapshot().informationSection, 'context')
  assert.equal(await controller.compact(), true)

  controller.openInformation('work')
  assert.equal(await controller.exitPlanMode(), true)
  controller.closeInformation()

  assert.equal(controller.getSnapshot().informationSection, undefined)
  assert.deepEqual(commands, [COMPACT_COMMAND, PLAN_OFF_COMMAND])
})

test('rejects malformed projection values instead of presenting recomputed or unsafe facts', () => {
  const { controller, projectionFaces } = fixture()
  projectionFaces.sessionStats.publish({ turns: -1 })
  projectionFaces.tokenUsage.publish({ uncachedInputTokens: 'secret' })
  projectionFaces.contextPressure.publish({ projectedTokens: Number.NaN, contextWindow: 8_000 })
  projectionFaces.todos.publish([{ content: 'unsafe\u0000todo', status: 'unknown' }])
  projectionFaces.plan.publish({ active: 'yes', pending: false })
  projectionFaces.goal.publish({ goal: { objective: 42 } })

  const view = controller.getSnapshot()
  assert.equal(view.statistics, undefined)
  assert.equal(view.context, undefined)
  assert.deepEqual(view.todos, [])
  assert.equal(view.plan, undefined)
  assert.equal(view.goal, undefined)
})
