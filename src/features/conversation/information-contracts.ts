export type ConversationInformationSection = 'context' | 'statistics' | 'work'
export type ConversationProjectionKey =
  | 'contextBreakdown'
  | 'contextPressure'
  | 'goal'
  | 'plan'
  | 'sessionStats'
  | 'todos'
  | 'tokenUsage'

export type ConversationProjectionValues = Readonly<Partial<Record<ConversationProjectionKey, unknown>>>

export interface ConversationTimingStatisticsView {
  readonly llmMs: number
  readonly steps: number
  readonly tokensPerSecond?: number
  readonly toolMs: number
  readonly ttftAverageMs?: number
  readonly turns: number
}

export interface ConversationTokenStatisticsView {
  readonly billedInputTokens: number
  readonly cacheHitPercent?: number
  readonly outputTokens: number
}

export interface ConversationStatisticsView {
  readonly timing?: ConversationTimingStatisticsView
  readonly tokens?: ConversationTokenStatisticsView
}

export interface ConversationContextBreakdownView {
  readonly messageTokens: number
  readonly systemTokens: number
  readonly toolsTokens: number
}

export interface ConversationContextView {
  readonly breakdown?: ConversationContextBreakdownView
  readonly contextWindow: number
  readonly percent: number
  readonly usedTokens: number
}

export interface ConversationTodoView {
  readonly content: string
  readonly status: 'completed' | 'in_progress' | 'pending'
}

export interface ConversationPlanView {
  readonly active: boolean
  readonly effective: boolean
  readonly pending: boolean
}

export interface ConversationGoalView {
  readonly blockedReason?: string
  readonly maxGoalRounds: number
  readonly objective: string
  readonly phase: 'active' | 'blocked' | 'complete' | 'paused'
  readonly roundsStarted: number
}

export interface ConversationLifecycleView {
  readonly details: string
  readonly kind: 'compaction' | 'retry'
  readonly title: string
}
