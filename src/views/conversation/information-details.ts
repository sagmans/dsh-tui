import type {
  ConversationInformationSection,
  ConversationSnapshotView,
  ConversationTodoView,
} from '../../features/conversation/model.js'
import {
  formatConversationDuration,
  formatConversationTokens,
} from '../../features/conversation/activity.js'

const NO_STATISTICS = 'Statistics unavailable.'
const NO_CONTEXT = 'Context pressure unavailable.'
const NO_WORK = 'No active plan, goal, or todos.'
const PLAN_ACTIVE = 'active'
const PLAN_INACTIVE = 'inactive'
const PLAN_PENDING = ' · transition pending'
const LINE_SEPARATOR = '\n'
const GROUP_SEPARATOR = ' · '
const TOKENS_PER_SECOND = 'tok/s'
const TODO_GLYPHS: Readonly<Record<ConversationTodoView['status'], string>> = Object.freeze({
  completed: 'x',
  in_progress: '>',
  pending: ' ',
})

export function conversationStatisticsSeat(snapshot: ConversationSnapshotView): string | undefined {
  const statistics = snapshot.statistics
  if (statistics === undefined) return undefined
  const groups: string[] = []
  if (statistics.timing !== undefined) {
    groups.push(`${String(statistics.timing.turns)}T/${String(statistics.timing.steps)}S`)
    const duration = statistics.timing.llmMs + statistics.timing.toolMs
    if (duration > 0) groups.push(formatConversationDuration(duration))
  }
  if (statistics.tokens !== undefined) {
    groups.push(`${formatConversationTokens(statistics.tokens.billedInputTokens)}/${formatConversationTokens(statistics.tokens.outputTokens)}`)
  }
  return ` STATS ${groups.join(GROUP_SEPARATOR)} `
}

export function conversationContextSeat(snapshot: ConversationSnapshotView): string | undefined {
  return snapshot.context === undefined ? undefined : ` CTX ${String(snapshot.context.percent)}% `
}

export function conversationWorkSeat(snapshot: ConversationSnapshotView): string | undefined {
  const groups: string[] = []
  if (snapshot.plan !== undefined) {
    groups.push(`PLAN ${snapshot.plan.effective ? 'ON' : 'OFF'}${snapshot.plan.pending ? '*' : ''}`)
  }
  if (snapshot.goal !== undefined) {
    groups.push(`GOAL ${snapshot.goal.phase.toUpperCase()} ${String(snapshot.goal.roundsStarted)}/${String(snapshot.goal.maxGoalRounds)}`)
  }
  if (snapshot.todos.length > 0) {
    const completed = snapshot.todos.filter(todo => todo.status === 'completed').length
    const active = snapshot.todos.filter(todo => todo.status === 'in_progress').length
    const pending = snapshot.todos.length - completed - active
    groups.push(`TODO ${String(completed)}/${String(active)}/${String(pending)}`)
  }
  return groups.length === 0 ? undefined : ` ${groups.join(GROUP_SEPARATOR)} `
}

function statisticsDetails(snapshot: ConversationSnapshotView): string {
  const statistics = snapshot.statistics
  if (statistics === undefined) return NO_STATISTICS
  const lines: string[] = []
  const timing = statistics.timing
  if (timing !== undefined) {
    lines.push(
      `Turns ${String(timing.turns)} · Steps ${String(timing.steps)}`,
      `LLM ${formatConversationDuration(timing.llmMs)} · Tools ${formatConversationDuration(timing.toolMs)}`,
    )
    if (timing.ttftAverageMs !== undefined) lines.push(`TTFT avg ${formatConversationDuration(timing.ttftAverageMs)}`)
    if (timing.tokensPerSecond !== undefined) {
      lines.push(`Decode ${String(Math.round(timing.tokensPerSecond * 10) / 10)} ${TOKENS_PER_SECOND}`)
    }
  }
  const tokens = statistics.tokens
  if (tokens !== undefined) {
    lines.push(`Input ${formatConversationTokens(tokens.billedInputTokens)} · Output ${formatConversationTokens(tokens.outputTokens)}`)
    if (tokens.cacheHitPercent !== undefined) lines.push(`Cache hit ${String(tokens.cacheHitPercent)}%`)
  }
  if (snapshot.lifecycle.length > 0) {
    lines.push('', 'Lifecycle')
    for (const item of snapshot.lifecycle) lines.push(`${item.title}${LINE_SEPARATOR}${item.details}`)
  }
  return lines.join(LINE_SEPARATOR)
}

function contextDetails(snapshot: ConversationSnapshotView): string {
  const context = snapshot.context
  if (context === undefined) return NO_CONTEXT
  const lines = [
    `Context used ${String(context.percent)}%`,
    `~${formatConversationTokens(context.usedTokens)} / ${formatConversationTokens(context.contextWindow)}`,
  ]
  if (context.breakdown !== undefined) {
    lines.push(
      `System ~${formatConversationTokens(context.breakdown.systemTokens)}`,
      `Tools ~${formatConversationTokens(context.breakdown.toolsTokens)}`,
      `Messages ~${formatConversationTokens(context.breakdown.messageTokens)}`,
    )
  }
  return lines.join(LINE_SEPARATOR)
}

function workDetails(snapshot: ConversationSnapshotView): string {
  const lines: string[] = []
  if (snapshot.plan !== undefined) {
    lines.push(`Plan ${snapshot.plan.effective ? PLAN_ACTIVE : PLAN_INACTIVE}${snapshot.plan.pending ? PLAN_PENDING : ''}`)
  }
  if (snapshot.goal !== undefined) {
    lines.push(
      `Goal ${snapshot.goal.phase} · round ${String(snapshot.goal.roundsStarted)}/${String(snapshot.goal.maxGoalRounds)}`,
      snapshot.goal.objective,
    )
    if (snapshot.goal.blockedReason !== undefined) lines.push(`Blocked: ${snapshot.goal.blockedReason}`)
  }
  if (snapshot.todos.length > 0) {
    lines.push('Todos')
    for (const todo of snapshot.todos) lines.push(`[${TODO_GLYPHS[todo.status]}] ${todo.content}`)
  }
  return lines.length === 0 ? NO_WORK : lines.join(LINE_SEPARATOR)
}

export function conversationInformationDetails(
  snapshot: ConversationSnapshotView,
  section: ConversationInformationSection,
): string {
  switch (section) {
    case 'statistics': return statisticsDetails(snapshot)
    case 'context': return contextDetails(snapshot)
    case 'work': return workDetails(snapshot)
    default: {
      const exhaustive: never = section
      return String(exhaustive)
    }
  }
}
