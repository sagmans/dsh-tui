import type {
  ModelSelection,
  SessionId,
  SessionModels,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { TuiNavigationStore } from '../../kernel/navigation.js'

export type ModelSelectionEntry = 'command' | 'composer'
export type ModelSelectionPane = 'effort' | 'model' | 'root'

export type ModelSelectionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

export interface ModelSelectionRowView {
  readonly details: string
  readonly enabled: boolean
  readonly id: string
  readonly selected: boolean
  readonly title: string
}

export interface ModelSelectionSnapshotView {
  readonly active: boolean
  readonly available: boolean
  readonly blocked: boolean
  readonly busy: boolean
  readonly currentLabel: string
  readonly effortLabel: string | undefined
  readonly entry: ModelSelectionEntry | undefined
  readonly error: string | undefined
  readonly overlayId: string | undefined
  readonly pane: ModelSelectionPane
  readonly routable: boolean | undefined
  readonly rowIndex: number
  readonly rows: readonly ModelSelectionRowView[]
  readonly status: string
}

export interface ModelSelectionListState {
  readonly byId: Readonly<Record<SessionId, { readonly blank: boolean } | undefined>>
  readonly current: SessionId | undefined
}

export interface ModelSelectionPort {
  models(sessionId: SessionId): Promise<ModelSelectionResult<SessionModels>>
  select(sessionId: SessionId, selection: ModelSelection): Promise<ModelSelectionResult<ModelSelection>>
}

export interface ModelSelectionControllerOptions {
  readonly available: (sessionId: SessionId) => boolean
  readonly list: ObservableSnapshot<ModelSelectionListState>
  readonly navigation: TuiNavigationStore
  readonly openProviders: () => void
  readonly port: ModelSelectionPort
}

export interface ModelSelectionController {
  activate(): Promise<boolean>
  back(): void
  close(): void
  dispose(): void
  getSnapshot(): ModelSelectionSnapshotView
  move(delta: number): void
  open(entry: ModelSelectionEntry): Promise<boolean>
  openProviders(): void
  refresh(): Promise<void>
  selectRow(index: number): void
  subscribe(listener: () => void): () => void
}
