import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-runtime/client'

export type InputTriggerSource = 'command' | 'skill' | 'subagent'

export type InputTriggerResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

export interface InputTriggerCommand {
  readonly description: string
  readonly inputHint?: string | undefined
  readonly name: string
}

export interface InputTriggerSkill {
  readonly description: string
  readonly modelInvocable: boolean
  readonly name: string
}

export interface InputTriggerCandidateView {
  readonly description?: string | undefined
  readonly hint?: string | undefined
  readonly name: string
}

export interface InputTriggerGroupView {
  readonly items: readonly InputTriggerCandidateView[]
  readonly source: InputTriggerSource
}

export interface InputTriggerHighlight {
  readonly index: number
  readonly source: InputTriggerSource
}

export interface InputTriggerSnapshotView {
  readonly groups: readonly InputTriggerGroupView[]
  readonly highlight: InputTriggerHighlight | undefined
  readonly launcher: boolean
  readonly open: boolean
  readonly pending: boolean
}

export interface InputTriggerMutation {
  readonly end: number
  readonly start: number
  readonly submit: boolean
  readonly text: string
}

export interface InputTriggerSessionSummary {
  readonly displayTitle: string
  readonly parentId?: SessionId | undefined
  readonly running: boolean
}

export interface InputTriggerSessionState {
  readonly byId: Readonly<Record<SessionId, InputTriggerSessionSummary | undefined>>
  readonly current: SessionId | undefined
}

export interface InputTriggerPort {
  commands(sessionId: SessionId): Promise<InputTriggerResult<readonly InputTriggerCommand[]>>
  serializeReference(
    source: InputTriggerSource,
    reference: string,
    signal: AbortSignal,
  ): Promise<string>
  skills(sessionId: SessionId): Promise<InputTriggerResult<readonly InputTriggerSkill[]>>
}

export interface InputTriggerControllerOptions {
  readonly modelAvailable?: ((sessionId: SessionId) => boolean) | undefined
  readonly port: InputTriggerPort
  readonly sessions: ObservableSnapshot<InputTriggerSessionState>
}

export interface InputTriggerController {
  dismiss(): void
  dispose(): void
  getSnapshot(): InputTriggerSnapshotView
  invalidate(sessionId?: SessionId): void
  launch(sessionId: SessionId, draft: string, caret: number): void
  move(delta: number): void
  pick(source: InputTriggerSource, index: number): InputTriggerMutation | undefined
  pickHighlighted(): InputTriggerMutation | undefined
  serialize(sessionId: SessionId, text: string, signal: AbortSignal): Promise<string>
  subscribe(listener: () => void): () => void
  track(sessionId: SessionId, draft: string, caret: number): void
}
