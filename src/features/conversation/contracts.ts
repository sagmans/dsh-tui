import type {
  MessageId,
  PromptContentPart,
  QueueAction,
  RpcResult,
  SessionId,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { ToolPresentation } from '../tools/contracts.js'
import type {
  InputTriggerController,
  InputTriggerSnapshotView,
  InputTriggerSource,
} from '../input-trigger/contracts.js'
import type {
  ConversationNode,
  ConversationSnapshot,
  ObservableSnapshot,
  PartialAssistant,
  RunningToolCall,
} from '@deepseek-ai/dsh-client-runtime/client'
export type ConversationPhase = 'empty' | 'error' | 'loading' | 'ready'
export type ConversationLineKind = 'assistant' | 'command' | 'context' | 'error' | 'system' | 'tool' | 'user'
export type ConversationSendMode = 'queue' | 'steer'
export type ConversationSubmitGesture = 'alternate' | 'primary'
export type ConversationInputKind = 'attachment' | 'export' | 'queue-edit'
export type ConversationModelSelectionEntry = 'command' | 'composer'
export type ConversationPreferenceSection = 'access' | 'presets'

export interface ConversationAttachmentView {
  readonly bytes: number
  readonly mediaType: Extract<PromptContentPart, { type: 'image' }>['mediaType']
  readonly name: string
}

export interface ConversationLoadedImage {
  readonly content: Extract<PromptContentPart, { type: 'image' }>
  readonly view: ConversationAttachmentView
}

export interface ConversationInputView {
  readonly kind: ConversationInputKind
  readonly placeholder: string
  readonly title: string
  readonly value: string
}

export interface ConversationMediaSource {
  exportSession(sessionId: SessionId, path: string, signal: AbortSignal): Promise<void>
  loadImage(path: string, signal: AbortSignal): Promise<ConversationLoadedImage>
}

export interface ConversationLine {
  readonly key: string
  readonly kind: ConversationLineKind
  readonly text: string
}

export interface ConversationQueueItemView {
  readonly busy: boolean
  readonly editable: boolean
  readonly id: MessageId
  readonly preview: string
}

export type WorkflowRunStatus = 'cancelled' | 'completed' | 'failed' | 'interrupted' | 'running'

export interface WorkflowMemberPresentation {
  readonly childId: SessionId
  readonly label: string
  readonly phase: string | undefined
  readonly status: WorkflowRunStatus
}

export interface WorkflowPresentation {
  readonly id: string
  readonly members: readonly WorkflowMemberPresentation[]
  readonly name: string
  readonly status: WorkflowRunStatus
}

export interface TuiConversationViewSnapshot {
  readonly lines: readonly ConversationLine[]
  readonly tools: readonly ToolPresentation[]
  readonly workflows: readonly WorkflowPresentation[]
}

declare module '@deepseek-ai/dsh-client-runtime/client' {
  interface ConversationViewSnapshotMap {
    tui: TuiConversationViewSnapshot
  }
}

export interface ConversationSnapshotView {
  readonly accessPreset: string | undefined
  readonly busyEnter: ConversationSendMode
  readonly busyEnterAvailable: boolean
  readonly busyEnterBusy: boolean
  readonly agentPreset: string | undefined
  readonly attachments: readonly ConversationAttachmentView[]
  readonly busy: boolean
  readonly draft: string
  readonly error: string | undefined
  readonly hasMore: boolean
  readonly lines: readonly ConversationLine[]
  readonly input: ConversationInputView | undefined
  readonly loadingOlder: boolean
  readonly modelAvailable: boolean
  readonly modelEffort: string | undefined
  readonly modelLabel: string | undefined
  readonly modelRoutable: boolean | undefined
  readonly phase: ConversationPhase
  readonly primarySendMode: ConversationSendMode
  readonly queue: readonly ConversationQueueItemView[]
  readonly queueMutable: boolean
  readonly running: boolean
  readonly sessionId: SessionId | undefined
  readonly status: string
  readonly suggestions: readonly string[]
  readonly title: string
  readonly trigger: InputTriggerSnapshotView | undefined
}

export interface ConversationSessionBinding {
  readonly getSnapshot: () => ConversationSnapshot
  readonly subscribe: (listener: () => void) => () => void
  cancel(): Promise<void>
  command(line: string): Promise<boolean>
  loadOlder(): Promise<void>
  prompt(content: readonly PromptContentPart[], mode: ConversationSendMode): Promise<void>
  updateQueue(itemId: MessageId, action: QueueAction): Promise<RpcResult<{ accepted: true }>>
}

export interface ConversationSessionsSource {
  readonly list: ObservableSnapshot<{
    readonly current: SessionId | undefined
    readonly byId: Readonly<Record<SessionId, {
      readonly agentPreset?: string | undefined
      readonly blank?: boolean | undefined
      readonly displayTitle: string
      readonly projectionValues?: Readonly<Record<string, unknown>> | undefined
    } | undefined>>
  }>
  binding(id: SessionId): ConversationSessionBinding | undefined
}

export interface ConversationCompletionSource {
  complete(sessionId: SessionId, query: string): Promise<readonly string[]>
}

export type ConversationPreferenceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

export interface ConversationSubmissionPreferences {
  read(): Promise<ConversationPreferenceResult<{
    readonly behavior: ConversationSendMode
    readonly revision: number
  }>>
  subscribe(listener: () => void): () => void
  write(
    behavior: ConversationSendMode,
    revision: number,
  ): Promise<ConversationPreferenceResult<{
    readonly behavior: ConversationSendMode
    readonly revision: number
  }>>
}

export interface ConversationModelSelectionSource extends ObservableSnapshot<{
  readonly available: boolean
  readonly currentLabel: string
  readonly effortLabel: string | undefined
  readonly routable: boolean | undefined
}> {
  open(entry: ConversationModelSelectionEntry): Promise<boolean>
}

export interface ConversationControllerOptions {
  readonly completion?: ConversationCompletionSource
  readonly media?: ConversationMediaSource
  readonly models?: ConversationModelSelectionSource | undefined
  readonly openSettings?: ((section: ConversationPreferenceSection) => void) | undefined
  readonly preferences?: ConversationSubmissionPreferences | undefined
  readonly triggers?: InputTriggerController | undefined
  readonly sessions: ConversationSessionsSource
}

export interface ConversationController {
  beginAttachment(): void
  beginExport(): void
  beginQueueEdit(itemId: MessageId): void
  cancel(): Promise<void>
  cancelInput(): void
  clearAttachments(): void
  complete(): Promise<void>
  dismissTrigger(): void
  dispose(): void
  getSnapshot(): ConversationSnapshotView
  launchTrigger(): void
  loadOlder(): Promise<void>
  moveTrigger(delta: number): void
  openModelSelection(entry: ConversationModelSelectionEntry): void
  openPreferences(section: ConversationPreferenceSection): void
  pickTrigger(source: InputTriggerSource, index: number): void
  pickTriggerHighlight(): void
  removeAttachment(index: number): void
  removeQueue(itemId: MessageId): Promise<boolean>
  scroll(delta: number): void
  scrollOffset(): number
  send(text: string, mode?: ConversationSendMode): Promise<boolean>
  sendAlternateDraft(): Promise<boolean>
  sendDraft(mode?: ConversationSendMode): Promise<boolean>
  setDraft(text: string, caret?: number): void
  setInput(value: string): void
  steerQueue(itemId: MessageId): Promise<boolean>
  steerQueueAll(): Promise<boolean>
  submitInput(): Promise<boolean>
  toggleBusyEnter(): Promise<boolean>
  subscribe(listener: () => void): () => void
}

export interface ConversationProjectionInput {
  readonly nodes: readonly ConversationNode[]
  readonly partial: PartialAssistant | null
  readonly runningCalls: readonly RunningToolCall[]
}
