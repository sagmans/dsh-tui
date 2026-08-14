import type { ConversationNode } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ConversationContextView,
  ConversationGoalView,
  ConversationLifecycleView,
  ConversationPlanView,
  ConversationProjectionKey,
  ConversationProjectionValues,
  ConversationStatisticsView,
  ConversationTodoView,
} from './contracts.js'
import { projectConversationLifecycle } from './activity.js'
import { sanitizeConversationText } from './projection.js'

export const CONVERSATION_PROJECTION_KEYS = Object.freeze([
  'sessionStats',
  'tokenUsage',
  'contextPressure',
  'contextBreakdown',
  'todos',
  'plan',
  'goal',
] as const satisfies readonly ConversationProjectionKey[])

const THOUSAND = 1_000
const PERCENT_SCALE = 100
const ZERO = 0

interface SessionStatsProjection {
  readonly turns: number
  readonly steps: number
  readonly llmMs: number
  readonly toolMs: number
  readonly ttftMs: number
  readonly ttftSteps: number
  readonly decodeMs: number
  readonly decodeTokens: number
}

interface TokenUsageProjection {
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

interface ContextPressureProjection {
  readonly pressureTokens?: number
  readonly projectedTokens?: number
  readonly contextWindow?: number
}

interface ContextBreakdownProjection {
  readonly systemTokens: number
  readonly toolsTokens: number
  readonly messageTokens: number
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= ZERO
}

function nonNegativeInteger(value: unknown): value is number {
  return nonNegative(value) && Number.isSafeInteger(value)
}

function sessionStats(value: unknown): SessionStatsProjection | undefined {
  if (!record(value)
    || !nonNegativeInteger(value.turns)
    || !nonNegativeInteger(value.steps)
    || !nonNegative(value.llmMs)
    || !nonNegative(value.toolMs)
    || !nonNegative(value.ttftMs)
    || !nonNegativeInteger(value.ttftSteps)
    || !nonNegative(value.decodeMs)
    || !nonNegativeInteger(value.decodeTokens)) return undefined
  return {
    turns: value.turns,
    steps: value.steps,
    llmMs: value.llmMs,
    toolMs: value.toolMs,
    ttftMs: value.ttftMs,
    ttftSteps: value.ttftSteps,
    decodeMs: value.decodeMs,
    decodeTokens: value.decodeTokens,
  }
}

function tokenUsage(value: unknown): TokenUsageProjection | undefined {
  if (!record(value)
    || !nonNegativeInteger(value.uncachedInputTokens)
    || !nonNegativeInteger(value.outputTokens)
    || !nonNegativeInteger(value.cacheReadTokens)
    || !nonNegativeInteger(value.cacheWriteTokens)) return undefined
  return {
    uncachedInputTokens: value.uncachedInputTokens,
    outputTokens: value.outputTokens,
    cacheReadTokens: value.cacheReadTokens,
    cacheWriteTokens: value.cacheWriteTokens,
  }
}

function contextPressure(value: unknown): ContextPressureProjection | undefined {
  if (!record(value)) return undefined
  const pressureTokens = value.pressureTokens
  const projectedTokens = value.projectedTokens
  const contextWindow = value.contextWindow
  if ((pressureTokens !== undefined && !nonNegative(pressureTokens))
    || (projectedTokens !== undefined && !nonNegative(projectedTokens))
    || (contextWindow !== undefined && (!nonNegative(contextWindow) || contextWindow === ZERO))) return undefined
  return {
    ...pressureTokens === undefined ? {} : { pressureTokens },
    ...projectedTokens === undefined ? {} : { projectedTokens },
    ...contextWindow === undefined ? {} : { contextWindow },
  }
}

function contextBreakdown(value: unknown): ContextBreakdownProjection | undefined {
  if (!record(value)
    || !nonNegative(value.systemTokens)
    || !nonNegative(value.toolsTokens)
    || !nonNegative(value.messageTokens)) return undefined
  return {
    systemTokens: value.systemTokens,
    toolsTokens: value.toolsTokens,
    messageTokens: value.messageTokens,
  }
}

function statisticsOf(values: ConversationProjectionValues): ConversationStatisticsView | undefined {
  const timingProjection = sessionStats(values.sessionStats)
  const usage = tokenUsage(values.tokenUsage)
  if (timingProjection === undefined && usage === undefined) return undefined
  const timing = timingProjection === undefined
    ? undefined
    : {
        turns: timingProjection.turns,
        steps: timingProjection.steps,
        llmMs: timingProjection.llmMs,
        toolMs: timingProjection.toolMs,
        ...timingProjection.ttftSteps === ZERO
          ? {}
          : { ttftAverageMs: timingProjection.ttftMs / timingProjection.ttftSteps },
        ...timingProjection.decodeMs === ZERO
          ? {}
          : { tokensPerSecond: timingProjection.decodeTokens / (timingProjection.decodeMs / THOUSAND) },
      }
  const tokens = usage === undefined
    ? undefined
    : (() => {
        const billedInputTokens = usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
        return {
          billedInputTokens,
          outputTokens: usage.outputTokens,
          ...billedInputTokens === ZERO
            ? {}
            : { cacheHitPercent: Math.round(usage.cacheReadTokens / billedInputTokens * PERCENT_SCALE) },
        }
      })()
  return {
    ...timing === undefined ? {} : { timing },
    ...tokens === undefined ? {} : { tokens },
  }
}

function contextOf(values: ConversationProjectionValues): ConversationContextView | undefined {
  const pressure = contextPressure(values.contextPressure)
  const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens
  const contextWindow = pressure?.contextWindow
  if (usedTokens === undefined || contextWindow === undefined) return undefined
  const breakdown = contextBreakdown(values.contextBreakdown)
  return {
    percent: Math.min(PERCENT_SCALE, Math.round(usedTokens / contextWindow * PERCENT_SCALE)),
    usedTokens,
    contextWindow,
    ...breakdown === undefined ? {} : { breakdown },
  }
}

function todosOf(value: unknown): readonly ConversationTodoView[] {
  if (value === null) return Object.freeze([])
  if (!Array.isArray(value)) return Object.freeze([])
  const todos: ConversationTodoView[] = []
  for (const item of value) {
    if (!record(item) || typeof item.content !== 'string') return Object.freeze([])
    if (item.status !== 'pending' && item.status !== 'in_progress' && item.status !== 'completed') {
      return Object.freeze([])
    }
    todos.push(Object.freeze({ content: sanitizeConversationText(item.content), status: item.status }))
  }
  return Object.freeze(todos)
}

function planOf(value: unknown): ConversationPlanView | undefined {
  if (!record(value) || typeof value.active !== 'boolean' || typeof value.pending !== 'boolean') return undefined
  return Object.freeze({
    active: value.active,
    pending: value.pending,
    effective: value.pending ? !value.active : value.active,
  })
}

function goalOf(value: unknown): ConversationGoalView | undefined {
  if (!record(value) || !record(value.goal)) return undefined
  const goal = value.goal
  if (typeof goal.objective !== 'string'
    || (goal.phase !== 'active' && goal.phase !== 'paused' && goal.phase !== 'blocked' && goal.phase !== 'complete')
    || !nonNegativeInteger(goal.maxGoalRounds)
    || !nonNegativeInteger(value.roundsStarted)) return undefined
  const blockedReason = goal.phase === 'blocked'
    && record(goal.blockedReason)
    && typeof goal.blockedReason.message === 'string'
    ? sanitizeConversationText(goal.blockedReason.message)
    : undefined
  return Object.freeze({
    maxGoalRounds: goal.maxGoalRounds,
    objective: sanitizeConversationText(goal.objective),
    phase: goal.phase,
    roundsStarted: value.roundsStarted,
    ...blockedReason === undefined ? {} : { blockedReason },
  })
}

export interface ConversationInformationProjection {
  readonly context: ConversationContextView | undefined
  readonly goal: ConversationGoalView | undefined
  readonly lifecycle: readonly ConversationLifecycleView[]
  readonly plan: ConversationPlanView | undefined
  readonly statistics: ConversationStatisticsView | undefined
  readonly todos: readonly ConversationTodoView[]
}

export function projectConversationInformation(
  values: ConversationProjectionValues,
  nodes: readonly ConversationNode[],
): ConversationInformationProjection {
  return Object.freeze({
    context: contextOf(values),
    goal: goalOf(values.goal),
    lifecycle: projectConversationLifecycle(nodes),
    plan: planOf(values.plan),
    statistics: statisticsOf(values),
    todos: todosOf(values.todos),
  })
}
