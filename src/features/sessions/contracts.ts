import type { SessionId, WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ObservableSnapshot,
  SessionListState,
  SessionSearchResultItem,
  WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { RpcResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { TuiNavigationStore } from '../../kernel/navigation.js'

export type SessionsRowKind = 'session' | 'workspace'
export type SessionsInputKind = 'create-workspace' | 'rename' | 'search'
export type SessionsPhase = 'error' | 'loading' | 'ready'

export interface SessionsRow {
  readonly key: string
  readonly kind: SessionsRowKind
  readonly title: string
  readonly detail: string | undefined
  readonly depth: number
  readonly selected: boolean
  readonly running: boolean
  readonly pending: boolean
  readonly expanded: boolean | undefined
  readonly sessionId: SessionId | undefined
  readonly workspaceId: WorkspaceId | undefined
}

export interface SessionsInputState {
  readonly kind: SessionsInputKind
  readonly initialValue: string
  readonly placeholder: string
  readonly title: string
  readonly sessionId: SessionId | undefined
  readonly workspaceId: WorkspaceId | undefined
}

export interface SessionsSnapshot {
  readonly activeRowKey: string | undefined
  readonly confirmDelete: boolean
  readonly error: string | undefined
  readonly input: SessionsInputState | undefined
  readonly phase: SessionsPhase
  readonly rows: readonly SessionsRow[]
  readonly searchHasMore: boolean
  readonly searchQuery: string
}

export interface SessionsSource {
  readonly list: ObservableSnapshot<SessionListState>
  clear(): void
  open(id: SessionId): void
  search(
    query: string,
    signal: AbortSignal,
  ): Promise<RpcResult<{ items: SessionSearchResultItem[]; hasMore: boolean }>>
  fork(options: { sessionId: SessionId }): Promise<SessionId>
  loadOlder(id: SessionId): Promise<void>
  rename(id: SessionId, title: string): Promise<void>
}

export interface WorkspacesSource {
  readonly list: ObservableSnapshot<WorkspaceListState>
  startSession(workspaceId?: WorkspaceId): void
  create(input: { path: string }): Promise<WorkspaceView>
  rename(workspaceId: WorkspaceId, title: string): Promise<WorkspaceView>
  delete(workspaceId: WorkspaceId): Promise<void>
  insertBefore(workspaceId: WorkspaceId, beforeWorkspaceId?: WorkspaceId): Promise<void>
  insertSessionBefore(
    workspaceId: WorkspaceId,
    sessionId: SessionId,
    beforeSessionId?: SessionId,
  ): Promise<WorkspaceView>
  archiveSession(sessionId: SessionId): Promise<void>
}

export interface SessionsControllerOptions {
  readonly navigation: TuiNavigationStore
  readonly sessions: SessionsSource
  readonly workspaces: WorkspacesSource
}

export interface SessionsController {
  accept(): void
  activate(): void
  archive(): Promise<void>
  cancel(): void
  close(): void
  confirmDelete(): Promise<void>
  deactivate(): void
  dispose(): void
  fork(): Promise<void>
  getSnapshot(): SessionsSnapshot
  loadOlder(): Promise<void>
  move(offset: number): void
  moveSelected(offset: number): Promise<void>
  openInput(kind: SessionsInputKind): void
  requestDelete(): void
  select(key: string): void
  startSession(): void
  submitInput(value: string): Promise<void>
  subscribe(listener: () => void): () => void
  toggleWorkspace(): void
}
