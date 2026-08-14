import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type {
  ConversationSnapshot,
  ObservableSnapshot,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { TuiNavigationStore } from '../../kernel/navigation.js'

export type TrajectoryDetailTab = 'input' | 'output' | 'timing' | 'raw'
export type TrajectoryRecordKind =
  | 'assistant'
  | 'command'
  | 'compacted'
  | 'context'
  | 'error'
  | 'retry'
  | 'subtool'
  | 'system'
  | 'tool'
  | 'user'
export type TrajectoryRowKind = 'record' | 'step' | 'turn'
export type TrajectoryTimelineMode = 'sequence' | 'time'

export interface TrajectoryTokenTotals {
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly reasoningTokens: number
}

export interface TrajectoryAggregateView extends TrajectoryTokenTotals {
  readonly durationMs: number
  readonly records: number
  readonly steps: number
  readonly turns: number
}

export interface TrajectoryRecordView {
  readonly depth: number
  readonly durationMs: number | undefined
  readonly error: boolean
  readonly key: string
  readonly kind: TrajectoryRecordKind
  readonly label: string
  readonly preview: string
  readonly seq: number
  readonly startedAt: number | undefined
  readonly step: number | undefined
  readonly tokens: TrajectoryTokenTotals
  readonly turn: number | undefined
}

export interface TrajectoryRowView {
  readonly collapsed: boolean
  readonly depth: number
  readonly error: boolean
  readonly foldable: boolean
  readonly key: string
  readonly kind: TrajectoryRowKind
  readonly label: string
  readonly preview: string
  readonly record: TrajectoryRecordView | undefined
  readonly step: number | undefined
  readonly turn: number | undefined
}

export interface TrajectoryDetailsView {
  readonly input: string
  readonly output: string
  readonly raw: string
  readonly timing: string
}

export interface TrajectoryTimelineSpanView {
  readonly durationMs?: number | undefined
  readonly endTime?: number | undefined
  readonly key: string
  readonly kind: TrajectoryRecordKind
  readonly lane: 0 | 1 | 2
  readonly sequence: number
  readonly startTime: number
}

export interface TrajectoryTimelineView {
  readonly mode: TrajectoryTimelineMode
  readonly spans: readonly TrajectoryTimelineSpanView[]
}

export interface TrajectorySnapshotView {
  readonly active: boolean
  readonly aggregate: TrajectoryAggregateView
  readonly busy: boolean
  readonly detailTab: TrajectoryDetailTab
  readonly details: TrajectoryDetailsView
  readonly error: string | undefined
  readonly hasMore: boolean
  readonly loadingOlder: boolean
  readonly overlayId: string | undefined
  readonly query: string
  readonly rowIndex: number
  readonly rows: readonly TrajectoryRowView[]
  readonly searchInput: string | undefined
  readonly selectedKey: string | undefined
  readonly sessionId: SessionId | undefined
  readonly status: string
  readonly timeline: TrajectoryTimelineView
  readonly totalRows: number
  readonly windowStart: number
}

export interface TrajectoryListState {
  readonly current: SessionId | undefined
}

export interface TrajectorySessionBinding {
  readonly getSnapshot: () => ConversationSnapshot
  readonly subscribe: (listener: () => void) => () => void
  loadOlder(): Promise<void>
}

export interface TrajectorySessionsSource {
  readonly list: ObservableSnapshot<TrajectoryListState>
  binding(id: SessionId): TrajectorySessionBinding | undefined
}

export interface TrajectoryControllerOptions {
  readonly navigation: TuiNavigationStore
  readonly sessions: TrajectorySessionsSource
}

export interface TrajectoryController {
  cancelSearch(): void
  clearSearch(): void
  close(): void
  dispose(): void
  getSnapshot(): TrajectorySnapshotView
  loadOlder(): Promise<boolean>
  move(delta: number): void
  moveDetailTab(delta: number): void
  open(): Promise<void>
  openSearch(): void
  selectDetailTab(tab: TrajectoryDetailTab): void
  selectRow(index: number): void
  setSearchInput(value: string): void
  submitSearch(): void
  subscribe(listener: () => void): () => void
  toggleFold(): void
  toggleTimelineMode(): void
}
