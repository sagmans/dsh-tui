import type { PendingInteraction } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  AnyInteractionWait,
  InteractionViewKind,
  InteractionWait,
} from './contracts.js'
import { sanitizeConversationText } from '../conversation/projection.js'

const MAX_QUESTIONS = 32
const MAX_OPTIONS = 64
const QUESTION_PRIORITY = 0
const APPROVAL_PRIORITY = 1
const RECOMMENDED_SUFFIX = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/iu

export interface NormalizedOption {
  readonly description: string | undefined
  readonly label: string
  readonly recommended: boolean
  readonly wireLabel: string
}

export interface NormalizedQuestion {
  readonly detail: string | undefined
  readonly header: string | undefined
  readonly id: string
  readonly intent: { readonly approve: string; readonly kind: 'plan-review' } | undefined
  readonly multiSelect: boolean
  readonly options: readonly NormalizedOption[]
  readonly question: string
}

export interface QuestionDraft {
  readonly custom: string
  readonly selected: readonly string[]
  readonly skipped: boolean
}

export interface PlanReview {
  readonly approve: string
  readonly decline: string | undefined
  readonly plan: string
  readonly question: NormalizedQuestion
}

export interface ActiveInteraction {
  readonly key: string
  readonly kind: InteractionViewKind
  readonly malformed: string | undefined
  readonly plan: PlanReview | undefined
  readonly questions: readonly NormalizedQuestion[]
  readonly wait: AnyInteractionWait
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null
}

function asWait(value: PendingInteraction): AnyInteractionWait | undefined {
  if (!record(value)
    || (value.kind !== 'approval' && value.kind !== 'question')
    || typeof value.key !== 'string'
    || typeof value.respond !== 'function'
    || !record(value.payload)) {
    return undefined
  }
  return value
}

export function selectedWait(pending: readonly PendingInteraction[]): AnyInteractionWait | undefined {
  const waits = pending.flatMap(item => {
    const wait = asWait(item)
    return wait === undefined ? [] : [wait]
  })
  return waits.toSorted((left, right) => {
    const leftPriority = left.kind === 'question' ? QUESTION_PRIORITY : APPROVAL_PRIORITY
    const rightPriority = right.kind === 'question' ? QUESTION_PRIORITY : APPROVAL_PRIORITY
    return leftPriority - rightPriority
  })[0]
}

function option(value: unknown): NormalizedOption | undefined {
  if (!record(value) || typeof value.label !== 'string' || value.label.trim() === '') return undefined
  if (value.description !== undefined && typeof value.description !== 'string') return undefined
  const recommended = RECOMMENDED_SUFFIX.test(value.label)
  return {
    description: typeof value.description === 'string' ? sanitizeConversationText(value.description) : undefined,
    label: sanitizeConversationText(recommended ? value.label.replace(RECOMMENDED_SUFFIX, '') : value.label),
    recommended,
    wireLabel: value.label,
  }
}

function intent(value: unknown): NormalizedQuestion['intent'] {
  if (!record(value) || value.kind !== 'plan-review' || typeof value.approve !== 'string') return undefined
  return { approve: value.approve, kind: 'plan-review' }
}

function normalizeQuestion(value: unknown): NormalizedQuestion | undefined {
  if (!record(value)
    || typeof value.id !== 'string'
    || value.id.trim() === ''
    || typeof value.question !== 'string'
    || value.question.trim() === ''
    || (value.detail !== undefined && typeof value.detail !== 'string')
    || (value.header !== undefined && typeof value.header !== 'string')
    || (value.multiSelect !== undefined && typeof value.multiSelect !== 'boolean')) {
    return undefined
  }
  const rawOptions = value.options === undefined ? [] : value.options
  if (!Array.isArray(rawOptions) || rawOptions.length > MAX_OPTIONS) return undefined
  const options = rawOptions.map(candidate => option(candidate))
  if (options.some(candidateOption => candidateOption === undefined)) return undefined
  const normalizedOptions = options.filter((candidateOption): candidateOption is NormalizedOption => candidateOption !== undefined)
  if (new Set(normalizedOptions.map(candidateOption => candidateOption.wireLabel)).size !== normalizedOptions.length) return undefined
  return {
    detail: typeof value.detail === 'string' ? sanitizeConversationText(value.detail) : undefined,
    header: typeof value.header === 'string' ? sanitizeConversationText(value.header) : undefined,
    id: value.id,
    intent: intent(value.intent),
    multiSelect: value.multiSelect === true,
    options: Object.freeze(normalizedOptions),
    question: sanitizeConversationText(value.question),
  }
}

function questionsOf(wait: InteractionWait<'question'>): {
  readonly malformed: string | undefined
  readonly questions: readonly NormalizedQuestion[]
} {
  const values: unknown = wait.payload.questions
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_QUESTIONS) {
    return { malformed: 'Question request is unavailable.', questions: [] }
  }
  const questions = values.map(value => normalizeQuestion(value))
  if (questions.some(question => question === undefined)) {
    return { malformed: 'Question request contains unsupported data.', questions: [] }
  }
  const normalized = questions.filter((question): question is NormalizedQuestion => question !== undefined)
  if (new Set(normalized.map(question => question.id)).size !== normalized.length) {
    return { malformed: 'Question request contains duplicate ids.', questions: [] }
  }
  return { malformed: undefined, questions: Object.freeze(normalized) }
}

function planReviewOf(questions: readonly NormalizedQuestion[]): PlanReview | undefined {
  if (questions.length !== 1) return undefined
  const question = questions[0]
  if (question === undefined
    || question.intent?.kind !== 'plan-review'
    || question.detail === undefined
    || question.multiSelect
    || question.options.length > 2) {
    return undefined
  }
  const approve = question.options.find(candidate => candidate.wireLabel === question.intent?.approve)
  if (approve === undefined) return undefined
  const decline = question.options.find(candidate => candidate.wireLabel !== approve.wireLabel)
  return {
    approve: approve.wireLabel,
    decline: decline?.wireLabel,
    plan: question.detail,
    question,
  }
}

function approvalMalformed(wait: InteractionWait<'approval'>): string | undefined {
  const payload: unknown = wait.payload
  if (!record(payload)
    || typeof payload.approvalId !== 'string'
    || payload.approvalId === ''
    || typeof payload.toolName !== 'string'
    || payload.toolName === ''
    || (payload.reason !== undefined && typeof payload.reason !== 'string')) {
    return 'Approval request is unavailable.'
  }
  return undefined
}

export function activate(wait: AnyInteractionWait): ActiveInteraction {
  if (wait.kind === 'approval') {
    const malformed = approvalMalformed(wait)
    return {
      key: wait.key,
      kind: malformed === undefined ? 'approval' : 'unavailable',
      malformed,
      plan: undefined,
      questions: [],
      wait,
    }
  }
  const normalized = questionsOf(wait)
  const plan = normalized.malformed === undefined ? planReviewOf(normalized.questions) : undefined
  return {
    key: wait.key,
    kind: normalized.malformed === undefined
      ? plan === undefined ? 'question' : 'plan-review'
      : 'unavailable',
    malformed: normalized.malformed,
    plan,
    questions: normalized.questions,
    wait,
  }
}

export function blankDraft(): QuestionDraft {
  return { custom: '', selected: [], skipped: false }
}

export function answered(draft: QuestionDraft): boolean {
  return draft.skipped || draft.selected.length > 0 || draft.custom.trim() !== ''
}
