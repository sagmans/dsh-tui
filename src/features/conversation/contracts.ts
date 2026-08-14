import type { PromptContentPart, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { ToolPresentation } from '../tools/contracts.js'
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
export type ConversationInputKind = 'attachment' | 'export'
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
  readonly running: boolean
  readonly sessionId: SessionId | undefined
  readonly status: string
  readonly suggestions: readonly string[]
  readonly title: string
}

export interface ConversationSessionBinding {
  readonly getSnapshot: () => ConversationSnapshot
  readonly subscribe: (listener: () => void) => () => void
  cancel(): Promise<void>
  command(line: string): Promise<boolean>
  loadOlder(): Promise<void>
  prompt(content: readonly PromptContentPart[], mode: ConversationSendMode): Promise<void>
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
  readonly sessions: ConversationSessionsSource
}

export interface ConversationController {
  beginAttachment(): void
  beginExport(): void
  cancel(): Promise<void>
  cancelInput(): void
  clearAttachments(): void
  complete(): Promise<void>
  dispose(): void
  getSnapshot(): ConversationSnapshotView
  loadOlder(): Promise<void>
  openModelSelection(entry: ConversationModelSelectionEntry): void
  openPreferences(section: ConversationPreferenceSection): void
  removeAttachment(index: number): void
  scroll(delta: number): void
  scrollOffset(): number
  send(text: string, mode?: ConversationSendMode): Promise<boolean>
  sendDraft(mode?: ConversationSendMode): Promise<boolean>
  setDraft(text: string): void
  setInput(value: string): void
  submitInput(): Promise<boolean>
  subscribe(listener: () => void): () => void
}

export interface ConversationProjectionInput {
  readonly nodes: readonly ConversationNode[]
  readonly partial: PartialAssistant | null
  readonly runningCalls: readonly RunningToolCall[]
}
