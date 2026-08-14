import type {
  AnyInteractionWait,
  InteractionsController,
  InteractionsControllerOptions,
  InteractionSessionBinding,
  InteractionSnapshotView,
  InteractionWait,
} from './contracts.js'
import {
  activate,
  answered,
  blankDraft,
  selectedWait,
  type ActiveInteraction,
  type PlanReview,
  type QuestionDraft,
} from './normalize.js'
import { projectInteractionSnapshot } from './projection.js'
import { sanitizeConversationText } from '../conversation/projection.js'
import { sanitizeText } from '../sessions/projection.js'

export type * from './contracts.js'
const OVERLAY_PREFIX = 'interaction:'
const FIRST_INDEX = 0

class InteractionsControllerService implements InteractionsController {
  private readonly listeners = new Set<() => void>()
  private readonly navigation: InteractionsControllerOptions['navigation']
  private readonly sessions: InteractionsControllerOptions['sessions']
  private readonly resources: Array<() => void>
  private active: ActiveInteraction | undefined
  private binding: InteractionSessionBinding | undefined
  private bindingDispose: (() => void) | undefined
  private busy = false
  private disposed = false
  private drafts: QuestionDraft[] = []
  private error: string | undefined
  private optionIndex = FIRST_INDEX
  private overlayId: string | undefined
  private publishPending = false
  private questionIndex = FIRST_INDEX

  constructor(options: InteractionsControllerOptions) {
    this.navigation = options.navigation
    this.sessions = options.sessions
    this.resources = [options.sessions.list.subscribe(() => { this.rebind() })]
    this.rebind(false)
  }

  approve(): Promise<boolean> {
    const active = this.active
    if (active?.kind === 'approval' && active.wait.kind === 'approval') {
      return this.respond(active.wait, {
        ok: true,
        value: {
          sessionId: active.wait.sessionId,
          approvalId: active.wait.payload.approvalId,
          outcome: 'allowed-once',
        },
      })
    }
    if (active?.kind === 'plan-review' && active.wait.kind === 'question' && active.plan !== undefined) {
      return this.answerReview(active.wait, active.plan, active.plan.approve)
    }
    return Promise.resolve(false)
  }

  cancel(): Promise<boolean> {
    const active = this.active
    if (active === undefined) return Promise.resolve(false)
    if (active.wait.kind === 'approval') return this.reject()
    return this.respond(active.wait, {
      ok: false,
      error: { code: 'cancelled', message: 'the user closed this question request', details: {} },
    })
  }

  chooseOption(index = this.optionIndex): void {
    const active = this.active
    const question = active?.questions[this.questionIndex]
    const draft = this.drafts[this.questionIndex]
    const selected = question?.options[index]
    if (active?.kind !== 'question' || question === undefined || draft === undefined || selected === undefined) return
    const nextSelected = question.multiSelect
      ? draft.selected.includes(selected.wireLabel)
        ? draft.selected.filter(label => label !== selected.wireLabel)
        : [...draft.selected, selected.wireLabel]
      : [selected.wireLabel]
    this.replaceDraft(this.questionIndex, {
      custom: question.multiSelect ? draft.custom : '',
      selected: nextSelected,
      skipped: false,
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.bindingDispose?.()
    this.bindingDispose = undefined
    if (this.overlayId !== undefined) this.navigation.dismissOverlay(this.overlayId)
    this.overlayId = undefined
    for (const dispose of this.resources.splice(0).toReversed()) dispose()
    this.listeners.clear()
  }

  getSnapshot(): InteractionSnapshotView {
    return projectInteractionSnapshot({
      active: this.active,
      busy: this.busy,
      drafts: this.drafts,
      error: this.error,
      optionIndex: this.optionIndex,
      overlayId: this.overlayId,
      questionIndex: this.questionIndex,
    })
  }

  moveOption(delta: number): void {
    const active = this.active
    const options = active?.questions[this.questionIndex]?.options ?? []
    if (active?.kind !== 'question' || options.length === 0 || !Number.isFinite(delta) || delta === 0) return
    const direction = delta < 0 ? -1 : 1
    this.optionIndex = (this.optionIndex + direction + options.length) % options.length
    this.schedulePublish()
  }

  nextQuestion(): void {
    const count = this.active?.questions.length ?? 0
    if (this.active?.kind !== 'question' || this.questionIndex >= count - 1) return
    this.questionIndex++
    this.optionIndex = FIRST_INDEX
    this.error = undefined
    this.schedulePublish()
  }

  previousQuestion(): void {
    if (this.active?.kind !== 'question' || this.questionIndex <= FIRST_INDEX) return
    this.questionIndex--
    this.optionIndex = FIRST_INDEX
    this.error = undefined
    this.schedulePublish()
  }

  reject(): Promise<boolean> {
    const active = this.active
    if (active?.kind === 'approval' && active.wait.kind === 'approval') {
      return this.respond(active.wait, {
        ok: true,
        value: {
          sessionId: active.wait.sessionId,
          approvalId: active.wait.payload.approvalId,
          outcome: 'rejected',
        },
      })
    }
    if (active?.kind === 'plan-review' && active.wait.kind === 'question' && active.plan?.decline !== undefined) {
      return this.answerReview(active.wait, active.plan, active.plan.decline)
    }
    return Promise.resolve(false)
  }

  selectOption(index: number): void {
    const options = this.active?.questions[this.questionIndex]?.options ?? []
    if (!Number.isSafeInteger(index) || index < 0 || index >= options.length) return
    this.optionIndex = index
    this.schedulePublish()
  }

  setCustom(value: string): void {
    const active = this.active
    const question = active?.questions[this.questionIndex]
    const draft = this.drafts[this.questionIndex]
    if (active?.kind !== 'question' || question === undefined || draft === undefined) return
    this.drafts = this.drafts.map((current, draftIndex) => draftIndex === this.questionIndex
      ? {
          custom: sanitizeConversationText(value),
          selected: question.multiSelect ? draft.selected : [],
          skipped: false,
        }
      : current)
    this.error = undefined
  }

  skipQuestion(): void {
    const active = this.active
    if (active?.kind !== 'question' || this.drafts[this.questionIndex] === undefined) return
    this.replaceDraft(this.questionIndex, { custom: '', selected: [], skipped: true })
    this.nextQuestion()
  }

  submit(): Promise<boolean> {
    const active = this.active
    if (active?.kind !== 'question' || active.wait.kind !== 'question') return Promise.resolve(false)
    const missing = this.drafts.findIndex(draft => !answered(draft))
    if (missing >= 0) {
      this.questionIndex = missing
      this.optionIndex = FIRST_INDEX
      this.error = 'Answer or skip every question.'
      this.schedulePublish()
      return Promise.resolve(false)
    }
    const answers = active.questions.map((question, index) => {
      const draft = this.drafts[index] ?? blankDraft()
      if (draft.skipped) return { id: question.id, selected: [] }
      const custom = draft.custom.trim()
      return {
        id: question.id,
        selected: custom === '' || question.multiSelect ? [...draft.selected] : [],
        ...custom === '' ? {} : { custom },
      }
    })
    return this.respond(active.wait, {
      ok: true,
      value: { sessionId: active.wait.sessionId, answer: { answers } },
    })
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private answerReview(wait: InteractionWait<'question'>, plan: PlanReview, label: string): Promise<boolean> {
    return this.respond(wait, {
      ok: true,
      value: {
        sessionId: wait.sessionId,
        answer: { answers: [{ id: plan.question.id, selected: [label] }] },
      },
    })
  }

  private rebind(publish = true): void {
    this.bindingDispose?.()
    const current = this.sessions.list.getSnapshot().current
    this.binding = current === undefined ? undefined : this.sessions.binding(current)
    this.bindingDispose = this.binding?.subscribe(() => { this.syncInteraction() })
    this.syncInteraction(publish)
  }

  private replaceDraft(index: number, draft: QuestionDraft): void {
    this.drafts = this.drafts.map((current, draftIndex) => draftIndex === index ? draft : current)
    this.error = undefined
    this.schedulePublish()
  }

  private async respond(wait: AnyInteractionWait, result: Parameters<InteractionWait['respond']>[0]): Promise<boolean> {
    if (this.busy || this.active?.wait !== wait) return false
    this.busy = true
    this.error = undefined
    this.schedulePublish()
    try {
      const receipt = await wait.respond(result)
      if (!receipt.accepted) throw new Error(`interaction response rejected: ${receipt.reason}`)
      return true
    } catch (error) {
      this.busy = false
      this.error = sanitizeText(error instanceof Error ? error.message : String(error))
      this.schedulePublish()
      return false
    }
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

  private syncInteraction(publish = true): void {
    const pending = this.binding?.getSnapshot().pending ?? []
    const wait = selectedWait(pending)
    const previousKey = this.active?.key
    const next = wait === undefined ? undefined : activate(wait)
    if (previousKey !== next?.key) {
      if (this.overlayId !== undefined) this.navigation.dismissOverlay(this.overlayId)
      this.overlayId = next === undefined ? undefined : `${OVERLAY_PREFIX}${next.key}`
      if (this.overlayId !== undefined
        && !this.navigation.getSnapshot().overlays.some(overlay => overlay.id === this.overlayId)) {
        this.navigation.openOverlay({ id: this.overlayId })
      }
      this.busy = false
      this.drafts = next?.questions.map(blankDraft) ?? []
      this.error = undefined
      this.optionIndex = FIRST_INDEX
      this.questionIndex = FIRST_INDEX
    }
    this.active = next
    if (publish) this.schedulePublish()
  }
}

export function createInteractionsController(options: InteractionsControllerOptions): InteractionsController {
  return new InteractionsControllerService(options)
}
