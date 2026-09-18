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

/** The markers the surface wraps a paste in once the terminal reports one. */
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

/** How many option rows a question shows at once, so a catalog-sized list leaves the editor in view. */
const QUESTION_WINDOW = 12

/** Drawn after a typed answer, so an empty question still shows where its text goes. */
const ANSWER_CURSOR = '▌'

/**
 * The text a bracketed paste carries, or undefined when the input is a key press.
 *
 * Control bytes are the terminal's, not the reader's: a copied key arrives with
 * the newline that copied it, and keeping that newline would confirm the
 * question before the reader saw what landed.
 */
function pastedText(data: string): string | undefined {
  const start = data.indexOf(PASTE_START)
  if (start === -1) return undefined
  const rest = data.slice(start + PASTE_START.length)
  const end = rest.indexOf(PASTE_END)
  return (end === -1 ? rest : rest.slice(0, end)).replace(/[\u0000-\u001f\u007f]/gu, '')
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
      const row = this.windowed(question).rows[Number.parseInt(data, 10) - 1]
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
      return { kind: 'question', title: 'question', detail: [], options: [], hint: 'finishing' }
    }
    const chosen = this.chosen[this.index] ?? []
    const detail = question.detail === undefined ? [] : lines(question.detail)
    const title = `${question.question}${this.questions.length > 1 ? `  (${this.index + 1}/${this.questions.length})` : ''}`
    if (question.options.length === 0) {
      // The row is the only place the text lands, so it is drawn even while
      // empty: a question answered by typing needs somewhere to paste a key.
      detail.push(`answer: ${this.typed}${ANSWER_CURSOR}`)
      return {
        kind: 'question',
        title,
        detail,
        options: [],
        hint: 'type or paste an answer · enter confirm · esc skip',
      }
    }
    if (this.typed !== '') detail.push(`filter: ${this.typed}`)
    const { rows, start, cursor } = this.windowed(question)
    return {
      kind: 'question',
      title,
      detail,
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
