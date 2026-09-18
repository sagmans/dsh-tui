import { matchesKey } from '@earendil-works/pi-tui'
import { pastedText } from './input.ts'

/** The outcome vocabulary the approval seam accepts from an answerer. */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled'

/** How a pending gate presents itself, independent of how it is drawn. */
export interface GateCard {
  readonly kind: 'approval' | 'question'
  readonly title: string
  readonly detail: readonly string[]
  /**
   * The number the first drawn option answers for. A list longer than the
   * screen shows a window of itself, and a window that restarts at one every
   * scroll hides where the reader is and contradicts the digits that pick by
   * that same number.
   */
  readonly optionOffset: number
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
      optionOffset: 0,
      options: [],
      hint: this.outcome === undefined ? 'y allow once · n reject · esc cancel' : 'decided',
    }
  }
}

/** One question as the seam describes it. */
export interface GateQuestion {
  readonly id: string
  readonly question: string
  readonly header: string | undefined
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
      header: typeof entry.header === 'string' ? entry.header : undefined,
      detail: typeof entry.detail === 'string' ? entry.detail : undefined,
      options,
      multiSelect: entry.multiSelect === true,
    })
  }
  return questions
}

/** How many option rows a question shows at once, so a catalog-sized list leaves the editor in view. */
const QUESTION_WINDOW = 12

/** Drawn after a typed answer, so an empty question still shows where its text goes. */
const ANSWER_CURSOR = '▌'

/** The row label a question earns when it asks for something that identifies its owner. */
const SECRET_LABEL = 'API KEY'

/** The row label for every other typed answer, where the text is the answer itself. */
const ANSWER_LABEL = 'answer'

/**
 * Words that mark a question as one whose answer is a secret. A plugin cannot
 * say so through the seam yet, and the question is where it already says it:
 * a person who loses a key to a shoulder loses an account, so the row keeps the
 * value out of sight rather than trusting every question to be harmless.
 */
const SECRET_WORDS = ['key', 'token', 'secret', 'password', 'passphrase', 'credential'] as const

const SECRET_PATTERN = new RegExp('\\b(?:' + SECRET_WORDS.join('|') + ')', 'iu')

/** How much of a secret stays readable, at each end, so its owner can recognize it. */
const MASK_HEAD = 4
const MASK_TAIL = 4
const MASK_CHAR = '*'

/** The words a question uses when it wants a secret rather than an answer. */
function asksForSecret(question: GateQuestion): boolean {
  return SECRET_PATTERN.test(question.question) || (question.header !== undefined && SECRET_PATTERN.test(question.header))
}

/** A secret with both ends readable: a field for its owner, and nothing for a bystander. */
function masked(value: string): string {
  if (value.length <= MASK_HEAD + MASK_TAIL) return value
  return value.slice(0, MASK_HEAD) + MASK_CHAR.repeat(value.length - MASK_HEAD - MASK_TAIL) + value.slice(-MASK_TAIL)
}

/** One option with the position it answers for, so filtering can drop rows and keep the meaning. */
interface PositionedOption {
  readonly option: GateQuestion['options'][number]
  readonly position: number
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

  /** Options the typed filter leaves, in the order they were listed. */
  private matched(question: GateQuestion): PositionedOption[] {
    const needle = this.typed.trim().toLowerCase()
    return question.options
      .map((option, position) => ({ option, position }))
      .filter(({ option }) => needle === ''
        || option.label.toLowerCase().includes(needle)
        || (option.description ?? '').toLowerCase().includes(needle))
  }

  /**
   * The rows the keys and the card agree on: the filter, then a window around
   * the cursor, because a list as long as a provider catalog would otherwise
   * push the editor off the screen.
   */
  private windowed(question: GateQuestion): { rows: PositionedOption[]; start: number; cursor: number } {
    const matched = this.matched(question)
    const cursor = Math.min(this.cursor, Math.max(0, matched.length - 1))
    const start = Math.max(0, Math.min(cursor - Math.floor(QUESTION_WINDOW / 2), matched.length - QUESTION_WINDOW))
    return { rows: matched.slice(start, start + QUESTION_WINDOW), start, cursor }
  }

  /** The row under the cursor, as the filter leaves it. */
  private currentRow(question: GateQuestion): PositionedOption | undefined {
    const matched = this.matched(question)
    return matched[Math.min(this.cursor, Math.max(0, matched.length - 1))]
  }

  /** Take or drop one source option, by single-select replacement or multi-select toggle. */
  private pick(position: number): void {
    const question = this.current
    const option = question?.options[position]
    if (question === undefined || option === undefined) return
    const chosen = this.chosen[this.index] ?? []
    this.chosen[this.index] = chosen.includes(option.label)
      ? chosen.filter(label => label !== option.label)
      : question.multiSelect === true ? [...chosen, option.label] : [option.label]
  }

  /** Add text to the filter, or to the answer a question without options collects. */
  private absorb(text: string): void {
    if (this.current === undefined || text === '') return
    this.typed += text
    this.cursor = 0
  }

  /** Apply one key press; returns the batch answer the first time it completes. */
  handleKey(data: string): GateAnswer[] | undefined {
    const question = this.current
    if (this.finished || question === undefined) return undefined
    const paste = pastedText(data)
    if (paste !== undefined) {
      this.absorb(paste)
      return undefined
    }
    if (matchesKey(data, 'up')) {
      this.cursor = Math.max(0, this.cursor - 1)
      return undefined
    }
    if (matchesKey(data, 'down')) {
      this.cursor = Math.min(Math.max(0, this.matched(question).length - 1), this.cursor + 1)
      return undefined
    }
    if (question.options.length > 0 && matchesKey(data, 'space')) {
      const row = this.currentRow(question)
      if (row !== undefined) this.pick(row.position)
      return undefined
    }
    if (matchesKey(data, 'escape')) {
      this.confirm()
      return this.result()
    }
    if (matchesKey(data, 'enter')) {
      const chosen = this.chosen[this.index] ?? []
      if (question.options.length > 0 && chosen.length === 0) {
        // A reader who typed enough to narrow the list is naming the row it
        // left under the cursor; one who typed an id the list does not hold is
        // naming that instead, which is why the typed text becomes the answer.
        const row = this.currentRow(question)
        if (row !== undefined) this.pick(row.position)
        else if (this.typed.trim() !== '') this.custom[this.index] = this.typed.trim()
      }
      this.confirm()
      return this.result()
    }
    if (matchesKey(data, 'backspace')) {
      this.typed = this.typed.slice(0, -1)
      this.cursor = 0
      return undefined
    }
    if (matchesKey(data, 'space')) {
      this.absorb(' ')
      return undefined
    }
    if (question.options.length > 0 && /^[1-9]$/u.test(data)) {
      const row = this.matched(question)[Number.parseInt(data, 10) - 1]
      if (row !== undefined) this.pick(row.position)
      return undefined
    }
    if (data.length === 1 && data >= ' ') this.absorb(data)
    return undefined
  }

  private confirm(): void {
    const question = this.current
    if (question === undefined) return
    if (question.options.length === 0) {
      const typed = this.typed.trim()
      if (typed !== '') this.custom[this.index] = typed
    }
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
      return { kind: 'question', title: 'question', detail: [], optionOffset: 0, options: [], hint: 'finishing' }
    }
    const chosen = this.chosen[this.index] ?? []
    const detail = question.detail === undefined ? [] : lines(question.detail)
    const heading = question.header === undefined ? '' : question.header + ' · '
    const title = `${heading}${question.question}${this.questions.length > 1 ? `  (${this.index + 1}/${this.questions.length})` : ''}`
    if (question.options.length === 0) {
      // The row is the only place the text lands, so it is drawn even while
      // empty: a question answered by typing needs somewhere to paste a key.
      const secret = asksForSecret(question)
      detail.push(`${secret ? SECRET_LABEL : ANSWER_LABEL}: ${secret ? masked(this.typed) : this.typed}${ANSWER_CURSOR}`)
      return {
        kind: 'question',
        title,
        detail,
        optionOffset: 0,
        options: [],
        hint: 'type or paste an answer · enter confirm · esc skip',
      }
    }
    if (this.typed !== '') detail.push(`filter: ${this.typed}`)
    const matched = this.matched(question)
    const { rows, start, cursor } = this.windowed(question)
    if (rows.length < matched.length) detail.push(`showing ${start + 1}–${start + rows.length} of ${matched.length}`)
    return {
      kind: 'question',
      title,
      detail,
      optionOffset: start,
      options: rows.map(({ option }, position) => ({
        label: option.label,
        description: option.description,
        current: start + position === cursor,
        selected: chosen.includes(option.label),
      })),
      hint: `${question.multiSelect ? 'space toggle' : 'space select'} · digits pick · type to filter · enter confirm · esc skip`,
    }
  }
}
