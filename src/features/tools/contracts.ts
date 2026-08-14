import type { SessionId, ToolCallView, ToolResultView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConversationSnapshot, ObservableSnapshot } from '@deepseek-ai/dsh-client-runtime/client'

export type ToolPresentationState = 'error' | 'ok' | 'running' | 'stopped'

export interface ToolPresentation {
  readonly callId: string
  readonly children: readonly ToolPresentation[]
  readonly details: string
  readonly name: string
  readonly paths: readonly string[]
  readonly state: ToolPresentationState
  readonly summary: string
  readonly title: string
}

export interface ToolPresentationInput {
  readonly args: string
  readonly callId: string
  readonly callView?: ToolCallView | undefined
  readonly children?: readonly ToolPresentation[] | undefined
  readonly errorCode?: string | undefined
  readonly isError: boolean
  readonly name: string
  readonly result?: string | undefined
  readonly resultView?: ToolResultView | undefined
}

export interface ToolInspectorRow {
  readonly callId: string
  readonly depth: number
  readonly expandable: boolean
  readonly expanded: boolean
  readonly name: string
  readonly state: ToolPresentationState
  readonly summary: string
  readonly title: string
}

export interface ToolsSnapshotView {
  readonly confirmationPath: string | undefined
  readonly details: string
  readonly phase: 'empty' | 'ready'
  readonly rows: readonly ToolInspectorRow[]
  readonly selectedCallId: string | undefined
  readonly status: string
  readonly title: string
}

export interface ToolsSessionBinding {
  readonly getSnapshot: () => ConversationSnapshot
  readonly subscribe: (listener: () => void) => () => void
}

export interface ToolsSessionsSource {
  readonly list: ObservableSnapshot<{
    readonly current: SessionId | undefined
    readonly byId: Readonly<Record<SessionId, { readonly displayTitle: string } | undefined>>
  }>
  binding(id: SessionId): ToolsSessionBinding | undefined
}

export interface ToolsControllerOptions {
  readonly openPath?: (path: string) => Promise<void>
  readonly sessions: ToolsSessionsSource
}

export interface ToolsController {
  dispose(): void
  getSnapshot(): ToolsSnapshotView
  move(delta: number): void
  openSelected(): Promise<boolean>
  select(callId: string): void
  subscribe(listener: () => void): () => void
  toggleSelected(): void
}
