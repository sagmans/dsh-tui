import type {
  ClientResponse,
  RpcReceipt,
  SessionId,
} from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ConversationSnapshot,
  ObservableSnapshot,
  PendingPayloads,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { TuiNavigationStore } from '../../kernel/navigation.js'

export type InteractionKind = keyof PendingPayloads
export type InteractionViewKind = 'approval' | 'plan-review' | 'question' | 'unavailable'

export interface InteractionWait<K extends InteractionKind = InteractionKind> {
  readonly key: string
  readonly kind: K
  readonly payload: PendingPayloads[K]
  readonly sessionId: SessionId
  respond(result: ClientResponse['result']): Promise<RpcReceipt>
}

export type AnyInteractionWait = {
  [Kind in InteractionKind]: InteractionWait<Kind>
}[InteractionKind]

export interface InteractionOptionView {
  readonly description: string | undefined
  readonly index: number
  readonly label: string
  readonly recommended: boolean
  readonly selected: boolean
}

export interface InteractionSnapshotView {
  readonly body: string
  readonly busy: boolean
  readonly canReject: boolean
  readonly canSubmit: boolean
  readonly custom: string
  readonly error: string | undefined
  readonly key: string | undefined
  readonly kind: InteractionViewKind | undefined
  readonly multiSelect: boolean
  readonly optionIndex: number
  readonly options: readonly InteractionOptionView[]
  readonly overlayId: string | undefined
  readonly questionIndex: number
  readonly questionCount: number
  readonly status: string
  readonly title: string
}

export interface InteractionSessionBinding {
  readonly getSnapshot: () => ConversationSnapshot
  readonly subscribe: (listener: () => void) => () => void
}

export interface InteractionSessionsSource {
  readonly list: ObservableSnapshot<{
    readonly current: SessionId | undefined
    readonly byId: Readonly<Record<SessionId, { readonly displayTitle: string } | undefined>>
  }>
  binding(id: SessionId): InteractionSessionBinding | undefined
}

export interface InteractionsControllerOptions {
  readonly navigation: TuiNavigationStore
  readonly sessions: InteractionSessionsSource
}

export interface InteractionsController {
  approve(): Promise<boolean>
  cancel(): Promise<boolean>
  chooseOption(index?: number): void
  dispose(): void
  getSnapshot(): InteractionSnapshotView
  moveOption(delta: number): void
  nextQuestion(): void
  previousQuestion(): void
  reject(): Promise<boolean>
  selectOption(index: number): void
  setCustom(value: string): void
  skipQuestion(): void
  submit(): Promise<boolean>
  subscribe(listener: () => void): () => void
}
