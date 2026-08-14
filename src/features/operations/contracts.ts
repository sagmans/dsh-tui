import type {
  ConversationSnapshot,
  ObservableSnapshot,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  GoalRef,
  MessageId,
  SessionId,
  SubagentAddress,
} from '@deepseek-ai/dsh-client-connection/client'
import type {
  MessageFeedbackItem,
  MessageFeedbackRating,
  MessageFeedbackVersion,
} from '@deepseek-ai/dsh-message-feedback/types'
import type { TuiActionSpec, TuiActionTone } from '../../contracts/actions.js'
import type { TuiNavigationStore } from '../../kernel/navigation.js'

export const OPERATION_ACTION_SCOPE = 'operations.action'
export const OPERATION_ACTION_IDS = Object.freeze([
  'feedback.clear',
  'feedback.negative',
  'feedback.note',
  'feedback.positive',
  'goal.clear',
  'goal.complete',
  'goal.edit',
  'goal.pause',
  'goal.resume',
  'plan.off',
  'subagent.open',
  'trajectory.open',
  'workflow.open',
] as const)

export type OperationsSection = 'goal' | 'plan' | 'workflows' | 'jobs' | 'subagents' | 'trajectory' | 'feedback'
export type OperationRowState = 'error' | 'idle' | 'running' | 'success' | 'warning'
export type OperationActionId = typeof OPERATION_ACTION_IDS[number]
export type OperationActionTone = TuiActionTone
export type OperationActionView = TuiActionSpec<OperationActionId>

export interface OperationRowView {
  readonly actions: readonly OperationActionView[]
  readonly details: string
  readonly id: string
  readonly state: OperationRowState
  readonly summary: string
  readonly title: string
}

export interface OperationInputView {
  readonly kind: 'feedback-note' | 'goal-edit'
  readonly title: string
  readonly value: string
}

export interface OperationsSnapshotView {
  readonly busy: boolean
  readonly confirmation: OperationActionId | undefined
  readonly error: string | undefined
  readonly input: OperationInputView | undefined
  readonly overlayId: string | undefined
  readonly rowIndex: number
  readonly rows: readonly OperationRowView[]
  readonly section: OperationsSection
  readonly selectedActionId: OperationActionId | undefined
  readonly sections: readonly OperationsSection[]
  readonly status: string
}

export interface OperationsSessionSummary {
  readonly displayTitle: string
  readonly origin?: 'subagent' | undefined
  readonly parentId?: SessionId | undefined
  readonly projectionValues?: Readonly<Record<string, unknown>> | undefined
  readonly running: boolean
}

export interface OperationsJobView {
  readonly detail?: string | undefined
  readonly finishedAt?: number | undefined
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly startedAt: number
  readonly status: 'completed' | 'failed' | 'killed' | 'running' | 'stopping'
}

export type OperationsSubagentEntry =
  | {
    readonly activity: 'inactive' | 'running'
    readonly hasChildren: boolean
    readonly id: SessionId
    readonly kind: 'child'
    readonly label?: string | undefined
    readonly mode: 'continuable' | 'one-shot'
  }
  | {
    readonly id: SessionId
    readonly kind: 'diagnostic'
    readonly reason: 'corrupt' | 'unavailable' | 'unsupported'
  }

export interface OperationsSubagentCatalog {
  readonly entries: readonly OperationsSubagentEntry[]
  readonly error: { readonly message: string } | null
  readonly parentAvailable: boolean
  readonly state: 'error' | 'loading' | 'ready'
}

export interface OperationsListState {
  readonly byId: Readonly<Record<string, OperationsSessionSummary | undefined>>
  readonly current: SessionId | undefined
  readonly jobsBySession: Readonly<Record<string, readonly OperationsJobView[] | undefined>>
  readonly subagentsByParent: Readonly<Record<string, OperationsSubagentCatalog | undefined>>
}

export interface OperationsSessionBinding {
  readonly getSnapshot: () => ConversationSnapshot
  readonly subscribe: (listener: () => void) => () => void
  loadOlder(): Promise<void>
}

export interface OperationsSessionsSource {
  readonly list: ObservableSnapshot<OperationsListState>
  binding(id: SessionId): OperationsSessionBinding | undefined
  open(id: SessionId): void
  openSubagent(address: SubagentAddress): void
  refreshSubagents(id: SessionId): Promise<void>
}

export interface GoalMutationRequest {
  readonly kind: 'clear' | 'complete' | 'edit' | 'pause' | 'resume'
  readonly objective?: string | undefined
  readonly ref: GoalRef
  readonly sessionId: SessionId
}

export type FeedbackItemView = MessageFeedbackItem

export type OperationsResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly current?: FeedbackItemView | null } }

export interface OperationsActions {
  deleteFeedback(request: {
    readonly messageId: MessageId
    readonly sessionId: SessionId
    readonly version: MessageFeedbackVersion
  }): Promise<OperationsResult<void>>
  listFeedback(sessionId: SessionId): Promise<OperationsResult<readonly FeedbackItemView[]>>
  mutateGoal(request: GoalMutationRequest): Promise<OperationsResult<GoalRef>>
  planOff(sessionId: SessionId): Promise<OperationsResult<void>>
  putFeedback(request: {
    readonly ifVersion: MessageFeedbackVersion | null
    readonly messageId: MessageId
    readonly note?: string | undefined
    readonly rating: MessageFeedbackRating
    readonly sessionId: SessionId
  }): Promise<OperationsResult<FeedbackItemView>>
}

export interface OperationsControllerOptions {
  readonly actions: OperationsActions
  readonly navigation: TuiNavigationStore
  readonly openTrajectory: () => void
  readonly sessions: OperationsSessionsSource
}

export interface OperationsController {
  cancelInput(): void
  close(): void
  dispose(): void
  getSnapshot(): OperationsSnapshotView
  move(delta: number): void
  moveAction(delta: number): void
  moveSection(delta: number): void
  open(): Promise<void>
  perform(action?: OperationActionId): Promise<boolean>
  selectRow(index: number): void
  selectSection(section: OperationsSection): void
  setInput(value: string): void
  submitInput(): Promise<boolean>
  subscribe(listener: () => void): () => void
  toggle(): Promise<void>
}
