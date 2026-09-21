import { matchesKey } from '@earendil-works/pi-tui'
import { actionLabel, keyName, keysFor, matchesAction, moveHint, type Keymap } from './input/actions.ts'
import { pastedText } from './input.ts'
import { matchScore } from './input/match.ts'

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
  /**
   * The row that answers with typed text. A question with no options is answered
   * by typing anyway, so it has no such row to draw.
   */
  readonly custom: GateCustomRow | undefined
  /**
   * The editor the answer is written in, drawn under the row that fills it.
   *
   * A question says nothing about its answer until someone writes one, so the
   * rows come from the surface's own editor rather than from text composed
   * here: the reader gets the cursor movement, deletion, undo, and paste the
   * prompt bar already has.
   */
  readonly answerInput: GateInput | undefined
  readonly hint: string
}

/**
 * The editor a question collects typed text with.
 *
 * These are the editor's own members rather than a vocabulary invented here, so
 * the surface hands in the component the prompt bar already uses and nothing
 * has to adapt it. Every key the gate does not claim — movement, deletion,
 * undo, a pasted block — reaches the answer through this.
 */
export type GateInputMode = 'answer' | 'secret'

export interface GateInput {
  /** The answer as written, with a pasted block expanded back to its text. */
  getExpandedText(): string
  /** Replace the answer, so the next question of a batch does not inherit one. */
  setText(text: string): void
  /** Lay the answer out for this width; its rows are drawn under the free-text row. */
  render(width: number): string[]
  /** Take a key the gate itself did not claim. */
  handleInput(data: string): void
  /**
   * How the surface shows the answer it is collecting, absent on an editor
   * that has no way to hide one.
   */
  setMode?(mode: GateInputMode): void
}

/** One selectable row of a question gate. */
export interface GateOption {
  readonly label: string
  readonly description: string | undefined
  readonly current: boolean
  readonly selected: boolean
}

/** The row that answers with typed text instead of a listed label. */
export interface GateCustomRow {
  readonly label: string
  readonly description: string | undefined
  /** Whether the cursor is on this row, which is what makes typing the answer. */
  readonly current: boolean
  /** Whether a custom answer is being formed or already holds text. */
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
    /** The keys in force, read per press so a settings edit lands on the next key. */
    private readonly keys: () => Keymap,
  ) {}

  get resolved(): boolean {
    return this.outcome !== undefined
  }

  /** Apply one key press; returns the outcome the first time it settles. */
  handleKey(data: string): ApprovalOutcome | undefined {
    if (this.outcome !== undefined) return undefined
    if (matchesAction(this.keys(), 'gate.allow', data)) this.outcome = 'allowed-once'
    else if (matchesAction(this.keys(), 'gate.reject', data)) this.outcome = 'rejected'
    else if (matchesAction(this.keys(), 'gate.cancel', data)) this.outcome = 'cancelled'
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
      answerInput: undefined,
      optionOffset: 0,
      options: [],
      custom: undefined,
      hint: this.outcome === undefined
        ? ['gate.allow', 'gate.reject', 'gate.cancel']
          .map(id => keysFor(this.keys(), id).map(key => `${keyName(key)} ${actionLabel(id)}`).join(' · '))
          .join(' · ')
        : 'decided',
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

/** The number the free-text row answers for. It sits below the window, so drawn numbering runs 1..n then 0. */
export const CUSTOM_ROW_NUMBER = 0

/** The label a question earns for an answer the model did not list. */
const CUSTOM_ROW_LABEL = 'other'

/** What the free-text row does, said where the reader decides. */
const CUSTOM_ROW_DESCRIPTION = 'type your own answer'

/** How the list hint names that row, which the row itself already labels. */
const CUSTOM_ROW_SHORTHAND = `${CUSTOM_ROW_NUMBER} answer freely`

/**
 * How a hint names the keys of one action.
 *
 * A hint is prose about what a key does here, so the word comes from the card
 * rather than from the catalog row, which has to read well out of context too.
 */
function namedKeys(map: Keymap, id: string, verb: string): string {
  // One verb for the action, however many keys reach it: a hint that repeated
  // the word would read as two actions rather than two ways to do one.
  return `${keysFor(map, id).map(keyName).join('/')} ${verb}`
}

/** The keys that answer the free-text row, where typing is the answer rather than a filter. */
function customHint(map: Keymap): string {
  return `type or paste an answer · ${namedKeys(map, 'question.confirm', 'confirm')} · ${moveHint(map, 'question.up', 'question.down')} or ${namedKeys(map, 'question.skip', 'back')} to options`
}

/**
 * The question-id suffix that declares a typed answer a credential. The seam
 * has no field for it, so a caller marks its own id and the gate reads that
 * declaration rather than the wording: ids are caller-owned, and a question
 * that merely mentions a key must still show the answer its author meant read.
 */
const SECRET_ID_SUFFIX = ':secret'

/** The free-text row's label when the answer is a credential, so the reader sees what they hand over. */
const SECRET_ROW_LABEL = 'API KEY'

/** Whether a question declares its typed answer a credential through its id. */
function declaresSecret(id: string): boolean {
  return id.endsWith(SECRET_ID_SUFFIX)
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
  /** Whether the cursor is on the free-text row. */
  private atCustom = false
  /**
   * The row an escape from the free-text row returns to.
   *
   * It is the row the reader last acted on — walked to, picked by its number, or
   * toggled — because that is the option they were looking at when they decided
   * to answer freely, and it is not always the row the cursor still stands on: a
   * digit picks by number without walking anywhere.
   */
  private customFrom = 0
  private readonly chosen: string[][] = []
  private readonly custom: (string | undefined)[] = []
  private finished = false

  constructor(
    private readonly questions: readonly GateQuestion[],
    /** The editor every typed answer is written in, whichever row asks for it. */
    private readonly input: GateInput,
    /** The keys in force, read per press so a settings edit lands on the next key. */
    private readonly keys: () => Keymap,
  ) {
    for (const _ of questions) {
      this.chosen.push([])
      this.custom.push(undefined)
    }
    this.resetInput()
  }

  /**
   * Empty the editor for the question now under the cursor.
   *
   * The editor belongs to the surface and outlives one question, so an answer
   * must never cross from the last question into the next — or from a gate that
   * was abandoned into the one that follows it. Its mode follows the question
   * for the same reason: a credential must not be shown because the last
   * question was not one.
   */
  private resetInput(): void {
    this.input.setText('')
    this.input.setMode?.(this.current !== undefined && declaresSecret(this.current.id) ? 'secret' : 'answer')
  }

  get resolved(): boolean {
    return this.finished
  }

  /**
   * Stop a question whose caller is gone.
   *
   * WHY: an aborted call has no reader for the answer, and a live gate would
   * otherwise keep the keyboard — and the borrowed editor — until someone
   * typed into a call that had already ended.
   */
  cancel(): void {
    this.finished = true
  }

  private get current(): GateQuestion | undefined {
    return this.questions[this.index]
  }

  /**
   * Options the typed filter leaves, in the order they were listed.
   *
   * The order is not the score order a picker uses: a digit answers by
   * position, and re-ranking rows would move the number the reader just read.
   */
  private matched(question: GateQuestion): PositionedOption[] {
    const needle = this.typed.trim()
    return question.options
      .map((option, position) => ({ option, position }))
      .filter(({ option }) => matchScore(needle, `${option.label} ${option.description ?? ''}`) !== undefined)
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

  /**
   * Whether a keystroke is answer text rather than a filter.
   *
   * A question without options has no list to filter, and the free-text row is
   * where a question with options collects an answer the model did not list.
   */
  private typingAnswer(question: GateQuestion): boolean {
    return question.options.length === 0 || this.atCustom
  }

  /** Add text to the filter, or to the answer the current row collects. */
  private absorb(text: string): void {
    const question = this.current
    if (question === undefined || text === '') return
    if (this.typingAnswer(question)) {
      // The editor decides what an insertion is: a paste arrives as one edit,
      // and a multi-character chunk is one undo step rather than many.
      this.input.handleInput(text)
      return
    }
    this.typed += text
    this.cursor = 0
    this.customFrom = 0
  }

  /** Apply one key press; returns the batch answer the first time it completes. */
  handleKey(data: string): GateAnswer[] | undefined {
    const question = this.current
    if (this.finished || question === undefined) return undefined
    const paste = pastedText(data)
    if (paste !== undefined) {
      // An answer takes the paste sequence itself, because the editor reads it;
      // a filter takes the text inside it, because nothing else would.
      this.absorb(this.typingAnswer(question) ? data : paste)
      return undefined
    }
    // The free-text row is a text field, so the keys that walk or pick a list
    // would otherwise take the very characters an answer is made of.
    if (this.atCustom) return this.handleCustomKey(data)

    const matched = this.matched(question)
    const keys = this.keys()
    if (matchesAction(keys, 'question.up', data)) {
      this.cursor = Math.max(0, this.cursor - 1)
      this.customFrom = this.cursor
      return undefined
    }
    if (matchesAction(keys, 'question.down', data)) {
      // Below the last option sits the free-text row, which is the second way
      // to reach it; a list with nothing left to show steps straight onto it.
      if (this.cursor >= matched.length - 1) {
        this.atCustom = true
      } else {
        this.cursor += 1
        this.customFrom = this.cursor
      }
      return undefined
    }
    if (question.options.length > 0 && matchesAction(keys, 'question.toggle', data)) {
      const row = this.currentRow(question)
      if (row !== undefined) this.pick(row.position)
      this.customFrom = this.cursor
      return undefined
    }
    if (matchesAction(keys, 'question.skip', data)) {
      this.advance()
      return this.result()
    }
    if (matchesAction(keys, 'question.confirm', data)) {
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
      // The same routing typing follows: a question without options has no
      // filter to erase, and the delete belongs to the answer it collected.
      if (this.typingAnswer(question)) {
        this.input.handleInput(data)
        return undefined
      }
      this.typed = this.typed.slice(0, -1)
      this.cursor = 0
      return undefined
    }
    if (matchesKey(data, 'space')) {
      this.absorb(' ')
      return undefined
    }
    if (question.options.length > 0 && /^[0-9]$/u.test(data)) {
      const digit = Number.parseInt(data, 10)
      if (digit === CUSTOM_ROW_NUMBER) {
        this.atCustom = true
        return undefined
      }
      const row = matched[digit - 1]
      if (row !== undefined) {
        this.pick(row.position)
        this.customFrom = digit - 1
      }
      return undefined
    }
    if (data.length === 1 && data >= ' ') this.absorb(data)
    return undefined
  }

  /**
   * One key press while the free-text row holds the cursor.
   *
   * Walking back to the list keeps whatever was typed, so a reader who changes
   * their mind about answering freely has not lost the text yet. An escape
   * leaves the row the same way, because a question skipped by accident is a
   * question the reader has to answer again: from the list, where every other
   * question is skipped, an escape skips this one too.
   */
  private handleCustomKey(data: string): GateAnswer[] | undefined {
    if (matchesAction(this.keys(), 'question.confirm', data)) {
      this.confirm()
      return this.result()
    }
    // The keys that leave a text field are the field's own, not the question's:
    // a skip the reader moved elsewhere must not quietly mean "walk back".
    if (matchesKey(data, 'up') || matchesKey(data, 'down')) {
      this.atCustom = false
      return undefined
    }
    if (matchesKey(data, 'escape')) {
      const question = this.current
      const rows = question === undefined ? 0 : this.matched(question).length
      this.atCustom = false
      this.cursor = Math.min(this.customFrom, Math.max(0, rows - 1))
      return undefined
    }
    // Anything else is the editor's: movement, deletion, undo, and the keys
    // that insert a character this gate has no business knowing about.
    this.input.handleInput(data)
    return undefined
  }

  /** Take the answer the reader confirmed, then leave the question. */
  private confirm(): void {
    const question = this.current
    if (question === undefined) return
    const text = this.input.getExpandedText().trim()
    if (text !== '') {
      this.custom[this.index] = text
      // The seam reads a single-select custom as the answer itself, so a label
      // picked before it would be a second answer the caller has to reconcile.
      if (question.multiSelect !== true) this.chosen[this.index] = []
    }
    this.advance()
  }

  /**
   * Leave the current question for the next one.
   *
   * Typed text belongs to the question being left, so it never crosses into the
   * next one — which is why a skipped question reports no typed answer at all.
   */
  private advance(): void {
    this.typed = ''
    this.atCustom = false
    this.customFrom = 0
    this.cursor = 0
    this.index += 1
    if (this.index >= this.questions.length) this.finished = true
    this.resetInput()
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
      return { kind: 'question', title: 'question', detail: [], optionOffset: 0, options: [], custom: undefined, answerInput: undefined, hint: 'finishing' }
    }
    const chosen = this.chosen[this.index] ?? []
    const detail = question.detail === undefined ? [] : lines(question.detail)
    const heading = question.header === undefined ? '' : question.header + ' · '
    const title = `${heading}${question.question}${this.questions.length > 1 ? `  (${this.index + 1}/${this.questions.length})` : ''}`
    if (question.options.length === 0) {
      return {
        kind: 'question',
        title,
        detail,
        optionOffset: 0,
        options: [],
        custom: undefined,
        // The editor is the only place the text lands, so it is drawn even while
        // empty: a question answered by typing needs somewhere to paste a key.
        answerInput: this.input,
        hint: `type or paste an answer · ${namedKeys(this.keys(), 'question.confirm', 'confirm')} · ${namedKeys(this.keys(), 'question.skip', 'skip')}`,
      }
    }
    if (this.typed !== '') detail.push(`filter: ${this.typed}`)
    // The editor holds the answer, so whether one has been written is its own
    // answer to give; the card only decides where to draw it.
    const written = this.input.getExpandedText() !== ''
    const secret = declaresSecret(question.id)
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
        // The free-text row wears the cursor when it holds it: a mark on a row
        // the reader is not pointing at is a mark that lies.
        current: !this.atCustom && start + position === cursor,
        selected: chosen.includes(option.label),
      })),
      custom: {
        label: secret ? SECRET_ROW_LABEL : CUSTOM_ROW_LABEL,
        description: CUSTOM_ROW_DESCRIPTION,
        current: this.atCustom,
        selected: this.atCustom || written,
      },
      // A written answer stays in view whether or not the cursor is on the row,
      // because it is what an enter is about to send.
      answerInput: this.atCustom || written ? this.input : undefined,
      hint: this.atCustom
        ? customHint(this.keys())
        : `${namedKeys(this.keys(), 'question.toggle', question.multiSelect ? 'toggle' : 'select')} · digits pick · ${CUSTOM_ROW_SHORTHAND} · type to filter · ${namedKeys(this.keys(), 'question.confirm', 'confirm')} · ${namedKeys(this.keys(), 'question.skip', 'skip')}`,
    }
  }
}
