import type {
  InteractionOptionView,
  InteractionSnapshotView,
} from './contracts.js'
import {
  answered,
  blankDraft,
  type ActiveInteraction,
  type QuestionDraft,
} from './normalize.js'
import { sanitizeConversationText } from '../conversation/projection.js'
import { sanitizeText } from '../sessions/projection.js'

const EMPTY_TITLE = 'WAITING FOR INPUT'
const FIRST_INDEX = 0

export interface InteractionProjectionState {
  readonly active: ActiveInteraction | undefined
  readonly busy: boolean
  readonly drafts: readonly QuestionDraft[]
  readonly error: string | undefined
  readonly optionIndex: number
  readonly overlayId: string | undefined
  readonly questionIndex: number
}

function approvalBody(active: ActiveInteraction): string {
  if (active.wait.kind !== 'approval') return ''
  const payload = active.wait.payload
  return sanitizeConversationText(payload.reason ?? `Approve ${payload.toolName}?`)
}

function approvalTitle(active: ActiveInteraction): string {
  return active.wait.kind === 'approval'
    ? `APPROVAL · ${sanitizeText(active.wait.payload.toolName)}`
    : EMPTY_TITLE
}

function statusOf(active: ActiveInteraction | undefined, busy: boolean, questionIndex: number): string {
  if (active === undefined) return 'No pending interaction.'
  if (busy) return 'Waiting for host confirmation…'
  switch (active.kind) {
    case 'approval': return 'y allow once · n reject · Esc reject'
    case 'plan-review': return active.plan?.decline === undefined
      ? 'y approve · d discuss'
      : 'y approve · n refuse · d discuss'
    case 'question': return `${questionIndex + 1}/${active.questions.length} · Space select · Ctrl+Enter submit`
    case 'unavailable': return 'Request cannot be rendered safely · Esc cancel'
    default: {
      const exhaustive: never = active.kind
      return String(exhaustive)
    }
  }
}

export function projectInteractionSnapshot(state: InteractionProjectionState): InteractionSnapshotView {
  const active = state.active
  const question = active?.questions[state.questionIndex]
  const draft = state.drafts[state.questionIndex] ?? blankDraft()
  const options = question?.options.map((candidate, index): InteractionOptionView => Object.freeze({
    description: candidate.description,
    index,
    label: candidate.label,
    selected: draft.selected.includes(candidate.wireLabel),
  })) ?? []
  const title = active === undefined
    ? EMPTY_TITLE
    : active.kind === 'approval'
      ? approvalTitle(active)
      : active.kind === 'plan-review'
        ? active.plan?.question.question ?? EMPTY_TITLE
        : active.kind === 'question'
          ? question?.question ?? EMPTY_TITLE
          : EMPTY_TITLE
  const body = active?.kind === 'approval'
    ? approvalBody(active)
    : active?.kind === 'plan-review'
      ? active.plan?.plan ?? ''
      : active?.kind === 'question'
        ? question?.detail ?? ''
        : active?.malformed ?? ''
  return Object.freeze({
    body,
    busy: state.busy,
    canReject: active?.kind === 'approval'
      || (active?.kind === 'plan-review' && active.plan?.decline !== undefined),
    canSubmit: active?.kind === 'question' && state.drafts.every(answered),
    custom: draft.custom,
    error: state.error,
    key: active?.key,
    kind: active?.kind,
    multiSelect: question?.multiSelect ?? false,
    optionIndex: Math.min(state.optionIndex, Math.max(FIRST_INDEX, options.length - 1)),
    options: Object.freeze(options),
    overlayId: state.overlayId,
    questionCount: active?.questions.length ?? 0,
    questionIndex: state.questionIndex,
    status: statusOf(active, state.busy, state.questionIndex),
    title,
  })
}
