import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { createActionCursor } from '../catalog/root.js'
import type {
  FeedbackItemView,
  GoalMutationRequest,
  OperationActionId,
  OperationsController,
  OperationsControllerOptions,
  OperationsSessionBinding,
  OperationsSnapshotView,
  OperationsSection,
  OperationsResult,
} from './contracts.js'
import {
  projectOperations,
  type OperationTarget,
  type ProjectedOperations,
} from './projection.js'
import { sanitizeConversationText } from '../conversation/projection.js'
import { sanitizeText } from '../sessions/projection.js'

export type * from './contracts.js'

const OVERLAY_ID = 'operations'
const FIRST_INDEX = 0
const SECTION_NAMES: readonly OperationsSection[] = Object.freeze([
  'goal',
  'plan',
  'workflows',
  'jobs',
  'subagents',
  'trajectory',
  'feedback',
])
const CONFIRMED_ACTIONS = new Set<OperationActionId>(['goal.clear', 'feedback.clear'])

function errorText(error: unknown): string {
  return sanitizeText(error instanceof Error ? error.message : String(error))
}

class OperationsControllerService implements OperationsController {
  private readonly actionCursor = createActionCursor<OperationActionId>()
  private readonly actions: OperationsControllerOptions['actions']
  private readonly listeners = new Set<() => void>()
  private readonly navigation: OperationsControllerOptions['navigation']
  private readonly sessions: OperationsControllerOptions['sessions']
  private binding: OperationsSessionBinding | undefined
  private bindingDispose: (() => void) | undefined
  private busy = false
  private confirmation: OperationActionId | undefined
  private confirmationToken: string | undefined
  private current: SessionId | undefined
  private disposed = false
  private error: string | undefined
  private feedback = new Map<string, FeedbackItemView>()
  private feedbackError: string | undefined
  private feedbackLoading = false
  private feedbackReady = false
  private input: OperationsSnapshotView['input']
  private overlayId: string | undefined
  private publishPending = false
  private readonly resources: Array<() => void>
  private rowIndex = FIRST_INDEX
  private section: OperationsSection = SECTION_NAMES[FIRST_INDEX] ?? 'goal'
  private subagentError: string | undefined

  constructor(options: OperationsControllerOptions) {
    this.actions = options.actions
    this.navigation = options.navigation
    this.sessions = options.sessions
    this.resources = [this.sessions.list.subscribe(() => { this.rebind() })]
    this.rebind(false)
  }

  cancelInput(): void {
    if (this.input === undefined) return
    this.input = undefined
    this.error = undefined
    this.schedulePublish()
  }

  close(): void {
    if (this.overlayId === undefined) return
    this.navigation.dismissOverlay(this.overlayId)
    this.overlayId = undefined
    this.clearConfirmation()
    this.input = undefined
    this.schedulePublish()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.bindingDispose?.()
    this.bindingDispose = undefined
    for (const dispose of this.resources.splice(0).toReversed()) dispose()
    if (this.overlayId !== undefined) this.navigation.dismissOverlay(this.overlayId)
    this.overlayId = undefined
    this.listeners.clear()
  }

  getSnapshot(): OperationsSnapshotView {
    const projected = this.projected()
    const maxIndex = Math.max(FIRST_INDEX, projected.rows.length - 1)
    const rowIndex = Math.min(this.rowIndex, maxIndex)
    const selectedActionId = this.actionCursor.current(projected.rows[rowIndex]?.actions ?? [])
    return Object.freeze({
      busy: this.busy,
      confirmation: this.confirmation,
      error: this.error ?? this.feedbackError ?? this.subagentError,
      input: this.input,
      overlayId: this.overlayId,
      rowIndex,
      rows: projected.rows,
      section: this.section,
      sections: SECTION_NAMES,
      selectedActionId,
      status: this.status(projected, rowIndex),
    })
  }

  move(delta: number): void {
    const count = this.projected().rows.length
    if (count === 0 || !Number.isFinite(delta) || delta === 0) return
    const direction = delta < 0 ? -1 : 1
    this.rowIndex = (this.rowIndex + direction + count) % count
    this.actionCursor.reset()
    this.clearConfirmation()
    this.schedulePublish()
  }

  moveAction(delta: number): void {
    const row = this.projected().rows[this.rowIndex]
    if (row === undefined) return
    this.actionCursor.move(row.actions, delta)
    this.clearConfirmation()
    this.schedulePublish()
  }

  moveSection(delta: number): void {
    if (!Number.isFinite(delta) || delta === 0) return
    const currentIndex = SECTION_NAMES.indexOf(this.section)
    const direction = delta < 0 ? -1 : 1
    const section = SECTION_NAMES[(currentIndex + direction + SECTION_NAMES.length) % SECTION_NAMES.length]
    if (section !== undefined) this.selectSection(section)
  }

  async open(): Promise<void> {
    if (this.disposed) return
    if (this.overlayId === undefined) {
      this.overlayId = OVERLAY_ID
      if (!this.navigation.getSnapshot().overlays.some(overlay => overlay.id === OVERLAY_ID)) {
        this.navigation.openOverlay({ id: OVERLAY_ID })
      }
    }
    this.schedulePublish()
    const sessionId = this.current
    if (sessionId === undefined) return
    await Promise.all([this.refreshFeedback(sessionId), this.refreshSubagents(sessionId)])
  }

  perform(action?: OperationActionId): Promise<boolean> {
    if (this.busy || this.input !== undefined) return Promise.resolve(false)
    const projected = this.projected()
    const row = projected.rows[this.rowIndex]
    const selectedAction = action ?? this.actionCursor.current(row?.actions ?? [])
    if (row === undefined
      || selectedAction === undefined
      || !row.actions.some(candidate => candidate.id === selectedAction && candidate.enabled)) {
      return Promise.resolve(false)
    }
    const target = projected.targets.get(row.id)
    if (target === undefined) return Promise.resolve(false)
    this.actionCursor.select(row.actions, selectedAction)
    const confirmationToken = this.confirmationIdentity(selectedAction, row.id, target)
    if (CONFIRMED_ACTIONS.has(selectedAction) && this.confirmationToken !== confirmationToken) {
      this.confirmation = selectedAction
      this.confirmationToken = confirmationToken
      this.schedulePublish()
      return Promise.resolve(false)
    }
    this.clearConfirmation()
    switch (selectedAction) {
      case 'goal.edit': return Promise.resolve(this.beginGoalEdit(target))
      case 'feedback.note': return Promise.resolve(this.beginFeedbackNote(target))
      case 'goal.pause': return this.mutateGoal(target, 'pause')
      case 'goal.resume': return this.mutateGoal(target, 'resume')
      case 'goal.complete': return this.mutateGoal(target, 'complete')
      case 'goal.clear': return this.mutateGoal(target, 'clear')
      case 'plan.off': return this.planOff(target)
      case 'subagent.open': return Promise.resolve(this.openSubagent(target))
      case 'workflow.open': return Promise.resolve(this.openWorkflow(target))
      case 'trajectory.older': return this.loadOlder(target)
      case 'feedback.positive': return this.rateFeedback(target, 'positive')
      case 'feedback.negative': return this.rateFeedback(target, 'negative')
      case 'feedback.clear': return this.clearFeedback(target)
      default: {
        const exhaustive: never = selectedAction
        return Promise.resolve(exhaustive)
      }
    }
  }

  selectRow(index: number): void {
    const rows = this.projected().rows
    if (!Number.isSafeInteger(index) || index < 0 || index >= rows.length) return
    this.rowIndex = index
    this.actionCursor.reset()
    this.clearConfirmation()
    this.schedulePublish()
  }

  selectSection(section: OperationsSection): void {
    if (!SECTION_NAMES.includes(section) || section === this.section) return
    this.section = section
    this.rowIndex = FIRST_INDEX
    this.actionCursor.reset()
    this.clearConfirmation()
    this.input = undefined
    this.error = undefined
    this.schedulePublish()
    if (section === 'feedback' && this.current !== undefined && !this.feedbackReady && !this.feedbackLoading) {
      void this.refreshFeedback(this.current)
    }
    if (section === 'subagents' && this.current !== undefined) {
      void this.refreshSubagents(this.current)
    }
  }

  setInput(value: string): void {
    if (this.input === undefined) return
    this.input = { ...this.input, value: sanitizeConversationText(value) }
  }

  submitInput(): Promise<boolean> {
    const input = this.input
    if (input === undefined || this.busy) return Promise.resolve(false)
    const projected = this.projected()
    const row = projected.rows[this.rowIndex]
    const target = row === undefined ? undefined : projected.targets.get(row.id)
    const value = input.value.trim()
    if (value === '') {
      this.error = 'Input cannot be blank.'
      this.schedulePublish()
      return Promise.resolve(false)
    }
    if (input.kind === 'goal-edit') return this.editGoal(target, value)
    return this.noteFeedback(target, value)
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async toggle(): Promise<void> {
    if (this.overlayId === undefined) await this.open()
    else this.close()
  }

  private beginFeedbackNote(target: OperationTarget): boolean {
    if (target.kind !== 'feedback' || target.item === undefined) return false
    this.input = { kind: 'feedback-note', title: 'Feedback note', value: target.item.note ?? '' }
    this.schedulePublish()
    return true
  }

  private beginGoalEdit(target: OperationTarget): boolean {
    if (target.kind !== 'goal') return false
    this.input = { kind: 'goal-edit', title: 'Edit goal', value: target.goal.objective }
    this.schedulePublish()
    return true
  }

  private async clearFeedback(target: OperationTarget): Promise<boolean> {
    const sessionId = this.current
    const item = target.kind === 'feedback' ? target.item : undefined
    if (target.kind !== 'feedback' || item === undefined || sessionId === undefined) return false
    const result = await this.run(() => this.actions.deleteFeedback({
      messageId: target.messageId,
      sessionId,
      version: item.version,
    }))
    if (!result.ok) {
      if (result.error.current !== undefined) this.commitFeedback(target.messageId, result.error.current)
      return false
    }
    this.feedback.delete(target.messageId)
    this.schedulePublish()
    return true
  }

  private async editGoal(target: OperationTarget | undefined, objective: string): Promise<boolean> {
    const success = await this.mutateGoal(target, 'edit', objective)
    if (success) {
      this.input = undefined
      this.schedulePublish()
    }
    return success
  }

  private loadOlder(target: OperationTarget): Promise<boolean> {
    if (target.kind !== 'trajectory' || this.binding === undefined) return Promise.resolve(false)
    return this.runVoid(() => this.binding?.loadOlder() ?? Promise.resolve())
  }

  private mutateGoal(
    target: OperationTarget | undefined,
    kind: GoalMutationRequest['kind'],
    objective?: string,
  ): Promise<boolean> {
    const sessionId = this.current
    if (target?.kind !== 'goal' || sessionId === undefined) return Promise.resolve(false)
    return this.runBoolean(() => this.actions.mutateGoal({
      kind,
      ...objective === undefined ? {} : { objective },
      ref: target.goal.ref,
      sessionId,
    }))
  }

  private async noteFeedback(target: OperationTarget | undefined, note: string): Promise<boolean> {
    if (target?.kind !== 'feedback' || target.item === undefined) return false
    const success = await this.putFeedback(target, target.item.rating, note)
    if (success) this.input = undefined
    return success
  }

  private openSubagent(target: OperationTarget): boolean {
    if (target.kind !== 'subagent' || this.current === undefined) return false
    this.sessions.openSubagent({
      parentSessionId: this.current,
      childSessionId: target.childId,
      mode: target.mode,
    })
    this.close()
    return true
  }

  private openWorkflow(target: OperationTarget): boolean {
    if (target.kind !== 'workflow') return false
    this.sessions.open(target.childId)
    this.close()
    return true
  }

  private planOff(target: OperationTarget): Promise<boolean> {
    const sessionId = this.current
    if (target.kind !== 'plan' || sessionId === undefined) return Promise.resolve(false)
    return this.runBoolean(() => this.actions.planOff(sessionId))
  }

  private projected(): ProjectedOperations {
    return projectOperations({
      conversation: this.binding?.getSnapshot(),
      feedback: this.feedback,
      feedbackError: this.feedbackError,
      feedbackLoading: this.feedbackLoading,
      list: this.sessions.list.getSnapshot(),
      section: this.section,
    })
  }

  private async putFeedback(
    target: Extract<OperationTarget, { kind: 'feedback' }>,
    rating: 'negative' | 'positive',
    note?: string,
  ): Promise<boolean> {
    const sessionId = this.current
    if (sessionId === undefined) return false
    const result = await this.run(() => this.actions.putFeedback({
      ifVersion: target.item?.version ?? null,
      messageId: target.messageId,
      ...note === undefined ? target.item?.note === undefined ? {} : { note: target.item.note } : { note },
      rating,
      sessionId,
    }))
    if (!result.ok) {
      if (result.error.current !== undefined) this.commitFeedback(target.messageId, result.error.current)
      return false
    }
    this.feedback.set(target.messageId, result.value)
    this.input = undefined
    this.schedulePublish()
    return true
  }

  private rateFeedback(target: OperationTarget, rating: 'negative' | 'positive'): Promise<boolean> {
    return target.kind === 'feedback' ? this.putFeedback(target, rating) : Promise.resolve(false)
  }

  private rebind(publish = true): void {
    const next = this.sessions.list.getSnapshot().current
    if (next === this.current) {
      if (publish) this.schedulePublish()
      return
    }
    this.bindingDispose?.()
    this.current = next
    this.binding = next === undefined ? undefined : this.sessions.binding(next)
    this.bindingDispose = this.binding?.subscribe(() => {
      this.clearConfirmation()
      this.schedulePublish()
    })
    this.feedback.clear()
    this.feedbackError = undefined
    this.feedbackLoading = false
    this.feedbackReady = false
    this.subagentError = undefined
    this.rowIndex = FIRST_INDEX
    this.actionCursor.reset()
    this.clearConfirmation()
    this.input = undefined
    if (publish) this.schedulePublish()
    if (this.overlayId !== undefined && next !== undefined) {
      void this.refreshFeedback(next)
      void this.refreshSubagents(next)
    }
  }

  private async refreshFeedback(sessionId: SessionId): Promise<void> {
    if (this.feedbackLoading || sessionId !== this.current) return
    this.feedbackLoading = true
    this.feedbackError = undefined
    this.schedulePublish()
    try {
      const result = await this.actions.listFeedback(sessionId)
      if (sessionId !== this.current || this.disposed) return
      this.feedbackReady = result.ok
      if (result.ok) this.feedback = new Map(result.value.map(item => [item.messageId, item]))
      else this.feedbackError = result.error.message
    } catch (error) {
      if (sessionId === this.current && !this.disposed) this.feedbackError = errorText(error)
    } finally {
      if (sessionId === this.current && !this.disposed) {
        this.feedbackLoading = false
        this.schedulePublish()
      }
    }
  }

  private async refreshSubagents(sessionId: SessionId): Promise<void> {
    try {
      await this.sessions.refreshSubagents(sessionId)
      if (sessionId === this.current && !this.disposed) this.subagentError = undefined
    } catch (error) {
      if (sessionId !== this.current || this.disposed) return
      this.subagentError = errorText(error)
    }
    this.schedulePublish()
  }

  private async run<T>(operation: () => Promise<OperationsResult<T>>): Promise<OperationsResult<T>> {
    this.busy = true
    this.error = undefined
    this.schedulePublish()
    try {
      const result = await operation()
      if (!result.ok) this.error = sanitizeText(`${result.error.message} (${result.error.code})`)
      return result
    } catch (error) {
      const message = errorText(error)
      this.error = message
      return { ok: false, error: { code: 'transport', message } }
    } finally {
      this.busy = false
      this.schedulePublish()
    }
  }

  private async runBoolean(operation: () => Promise<OperationsResult<unknown>>): Promise<boolean> {
    return (await this.run(operation)).ok
  }

  private async runVoid(operation: () => Promise<void>): Promise<boolean> {
    this.busy = true
    this.error = undefined
    this.schedulePublish()
    try {
      await operation()
      return true
    } catch (error) {
      this.error = errorText(error)
      return false
    } finally {
      this.busy = false
      this.schedulePublish()
    }
  }

  private clearConfirmation(): void {
    this.confirmation = undefined
    this.confirmationToken = undefined
  }

  private confirmationIdentity(action: OperationActionId, rowId: string, target: OperationTarget): string {
    const revision = target.kind === 'goal'
      ? target.goal.ref.revision
      : target.kind === 'feedback'
        ? target.item?.version
        : undefined
    return JSON.stringify([action, rowId, revision])
  }

  private schedulePublish(): void {
    if (this.publishPending || this.disposed) return
    this.publishPending = true
    queueMicrotask(() => {
      this.publishPending = false
      if (this.disposed) return
      for (const listener of this.listeners) listener()
    })
  }

  private status(projected: ProjectedOperations, rowIndex: number): string {
    if (this.current === undefined) return 'No active session.'
    if (this.busy || this.feedbackLoading) return 'Waiting for host…'
    if (this.confirmation !== undefined) return `Press action again to confirm ${this.confirmation}.`
    if (this.input !== undefined) return 'Ctrl+Enter save · Esc cancel'
    if (projected.rows.length === 0) return `No ${this.section} data.`
    const row = projected.rows[rowIndex]
    return `${rowIndex + 1}/${projected.rows.length} · ${row?.actions.map(action => action.label).join(' · ') ?? 'read only'}`
  }

  private commitFeedback(messageId: string, item: FeedbackItemView | null): void {
    if (item === null) this.feedback.delete(messageId)
    else this.feedback.set(messageId, item)
    this.schedulePublish()
  }
}

export function createOperationsController(options: OperationsControllerOptions): OperationsController {
  return new OperationsControllerService(options)
}
