import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
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

export interface ConversationLine {
  readonly key: string
  readonly kind: ConversationLineKind
  readonly text: string
}

export interface TuiConversationViewSnapshot {
  readonly lines: readonly ConversationLine[]
  readonly tools: readonly ToolPresentation[]
}

declare module '@deepseek-ai/dsh-client-runtime/client' {
  interface ConversationViewSnapshotMap {
    tui: TuiConversationViewSnapshot
  }
}

export interface ConversationSnapshotView {
  readonly draft: string
  readonly error: string | undefined
  readonly hasMore: boolean
  readonly lines: readonly ConversationLine[]
  readonly loadingOlder: boolean
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
  prompt(text: string, mode: ConversationSendMode): Promise<void>
}

export interface ConversationSessionsSource {
  readonly list: ObservableSnapshot<{
    readonly current: SessionId | undefined
    readonly byId: Readonly<Record<SessionId, { readonly displayTitle: string } | undefined>>
  }>
  binding(id: SessionId): ConversationSessionBinding | undefined
}

export interface ConversationCompletionSource {
  complete(sessionId: SessionId, query: string): Promise<readonly string[]>
}

export interface ConversationControllerOptions {
  readonly completion?: ConversationCompletionSource
  readonly sessions: ConversationSessionsSource
}

export interface ConversationController {
  cancel(): Promise<void>
  complete(): Promise<void>
  dispose(): void
  getSnapshot(): ConversationSnapshotView
  loadOlder(): Promise<void>
  scroll(delta: number): void
  scrollOffset(): number
  send(text: string, mode?: ConversationSendMode): Promise<boolean>
  sendDraft(mode?: ConversationSendMode): Promise<boolean>
  setDraft(text: string): void
  subscribe(listener: () => void): () => void
}

export interface ConversationProjectionInput {
  readonly nodes: readonly ConversationNode[]
  readonly partial: PartialAssistant | null
  readonly runningCalls: readonly RunningToolCall[]
}
