import { matchesKey } from '@earendil-works/pi-tui'

/** The outcome vocabulary the approval seam accepts from an answerer. */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled'

/** How a pending gate presents itself, independent of how it is drawn. */
export interface GateCard {
  readonly kind: 'approval' | 'question'
  readonly title: string
  readonly detail: readonly string[]
  readonly options: readonly GateOption[]
  readonly hint: string
}

/** One selectable row of a question gate. */
export interface GateOption {
  readonly label: string
  readonly description: string | undefined
  readonly current: boolean
  readonly selected: boolean
}

function lines(value: string): string[] {
  return value.split('\n').filter(line => line.trim() !== '')
}

/**
 * One pending approval.
 *
 * The gate is a pure state machine: it turns key presses into the one outcome
 * the seam accepts and never infers a durable grant, because a terminal key
 * press is a single decision about a single call.
 */
export class ApprovalGate {
  private outcome: ApprovalOutcome | undefined

  constructor(
    private readonly toolName: string,
    private readonly reason: string | undefined,
  ) {}

  get resolved(): boolean {
    return this.outcome !== undefined
  }

  /** Apply one key press; returns the outcome the first time it settles. */
  handleKey(data: string): ApprovalOutcome | undefined {
    if (this.outcome !== undefined) return undefined
    if (matchesKey(data, 'y')) this.outcome = 'allowed-once'
    else if (matchesKey(data, 'n')) this.outcome = 'rejected'
    else if (matchesKey(data, 'escape')) this.outcome = 'cancelled'
    return this.outcome
  }

  cancel(): void {
    this.outcome ??= 'cancelled'
  }

  card(): GateCard {
    return {
      kind: 'approval',
      title: `approval needed · ${this.toolName}`,
      detail: this.reason === undefined ? [] : lines(this.reason),
      options: [],
      hint: this.outcome === undefined ? 'y allow once · n reject · esc cancel' : 'decided',
    }
  }
}

/** One question as the seam describes it. */
export interface GateQuestion {
  readonly id: string
  readonly question: string
  readonly detail: string | undefined
  readonly options: readonly { readonly label: string; readonly description: string | undefined }[]
  readonly multiSelect: boolean
}

/** One answered question in the batch result. */
export interface GateAnswer {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/**
 * Read the seam's request into the gate's own vocabulary.
 *
 * A question without options is answered by typing, which is why it becomes an
 * option-less gate rather than a rejected request: the model asked for text.
 */
export function toGateQuestions(request: unknown): GateQuestion[] {
  const record = asRecord(request)
  const raw = Array.isArray(record?.questions) ? record.questions : []
  const questions: GateQuestion[] = []
  for (const item of raw) {
    const entry = asRecord(item)
    if (entry === undefined || typeof entry.id !== 'string') continue
    const options = (Array.isArray(entry.options) ? entry.options : []).flatMap(option => {
      const candidate = asRecord(option)
      if (candidate === undefined || typeof candidate.label !== 'string') return []
      return [{
        label: candidate.label,
        description: typeof candidate.description === 'string' ? candidate.description : undefined,
      }]
    })
    questions.push({
      id: entry.id,
      question: typeof entry.question === 'string' ? entry.question : 'question',
      detail: typeof entry.detail === 'string' ? entry.detail : undefined,
      options,
      multiSelect: entry.multiSelect === true,
    })
  }
  return questions
}

/**
 * A pending batch of questions.
 *
 * Answers are collected per question and returned in the seam's shape. An
 * escape skips the current question with an empty selection rather than
 * aborting the batch, so a human who cannot answer one question still returns
 * everything else they decided.
 */
export class QuestionGate {
  private index = 0
  private cursor = 0
  private typed = ''
  private readonly chosen: string[][] = []
  private readonly custom: (string | undefined)[] = []
  private finished = false

  constructor(private readonly questions: readonly GateQuestion[]) {
    for (const _ of questions) {
      this.chosen.push([])
      this.custom.push(undefined)
    }
  }

  get resolved(): boolean {
    return this.finished
  }

  private get current(): GateQuestion | undefined {
    return this.questions[this.index]
  }

  /** Apply one key press; returns the batch answer the first time it completes. */
  handleKey(data: string): GateAnswer[] | undefined {
    const question = this.current
    if (this.finished || question === undefined) return undefined
    if (matchesKey(data, 'up')) {
      this.cursor = Math.max(0, this.cursor - 1)
      return undefined
    }
    if (matchesKey(data, 'down')) {
      this.cursor = Math.min(Math.max(0, question.options.length - 1), this.cursor + 1)
      return undefined
    }
    if (question.options.length > 0 && matchesKey(data, 'space')) {
      const option = question.options[this.cursor]
      if (option !== undefined) {
        const chosen = this.chosen[this.index] ?? []
        this.chosen[this.index] = chosen.includes(option.label)
          ? chosen.filter(label => label !== option.label)
          : question.multiSelect ? [...chosen, option.label] : [option.label]
      }
      return undefined
    }
    if (matchesKey(data, 'escape')) {
      this.confirm()
      return this.result()
    }
    if (matchesKey(data, 'enter')) {
      this.confirm()
      return this.result()
    }
    if (matchesKey(data, 'backspace')) {
      this.typed = this.typed.slice(0, -1)
      return undefined
    }
    if (matchesKey(data, 'space')) {
      this.typed += ' '
      return undefined
    }
    if (/^[1-9]$/u.test(data)) {
      const option = question.options[Number.parseInt(data, 10) - 1]
      if (option !== undefined) {
        const chosen = this.chosen[this.index] ?? []
        this.chosen[this.index] = chosen.includes(option.label)
          ? chosen.filter(label => label !== option.label)
          : question.multiSelect ? [...chosen, option.label] : [option.label]
      }
      return undefined
    }
    if (data.length === 1 && data >= ' ') this.typed += data
    return undefined
  }

  private confirm(): void {
    const question = this.current
    if (question === undefined) return
    const typed = this.typed.trim()
    if (typed !== '') this.custom[this.index] = typed
    this.typed = ''
    this.cursor = 0
    this.index += 1
    if (this.index >= this.questions.length) this.finished = true
  }

  private result(): GateAnswer[] | undefined {
    if (!this.finished) return undefined
    return this.questions.map((question, position) => {
      const custom = this.custom[position]
      return {
        id: question.id,
        selected: this.chosen[position] ?? [],
        ...(custom === undefined ? {} : { custom }),
      }
    })
  }

  card(): GateCard {
    const question = this.current
    if (question === undefined) {
      return { kind: 'question', title: 'question', detail: [], options: [], hint: 'finishing' }
    }
    const chosen = this.chosen[this.index] ?? []
    const detail = question.detail === undefined ? [] : lines(question.detail)
    if (this.typed !== '') detail.push(`typed: ${this.typed}`)
    return {
      kind: 'question',
      title: `${question.question}${this.questions.length > 1 ? `  (${this.index + 1}/${this.questions.length})` : ''}`,
      detail,
      options: question.options.map((option, position) => ({
        label: option.label,
        description: option.description,
        current: position === this.cursor,
        selected: chosen.includes(option.label),
      })),
      hint: question.options.length === 0
        ? 'type an answer · enter confirm · esc skip'
        : `${question.multiSelect ? 'space toggle' : 'space select'} · digits pick · enter confirm · esc skip`,
    }
  }
}
