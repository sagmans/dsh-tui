import { questionCard } from './question-card.ts'
import { type GateCard, type GateInput, lines, type GateQuestion, type GateAnswer, CUSTOM_ROW_NUMBER } from '../gates.ts'
import { CUSTOM_ROW_LABEL, CUSTOM_ROW_DESCRIPTION, CUSTOM_ROW_SHORTHAND, namedKeys, customRowExits, customHint, SECRET_ROW_LABEL, declaresSecret } from './question-card.ts'
import { matchesKey } from '@earendil-works/pi-tui'
import { matchesAction, type Keymap } from '../input/actions.ts'
import { pastedText } from '../input.ts'
import { matchScore } from '../input/match.ts'

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

/**
 * Whether a press leaves the free-text row for the option list.
 *
 * The arrows are the field's own, so they leave whatever the map says, which
 * keeps a reader who moved the question keys from being stranded in the field;
 * the question's own keys follow the map so a rebound alias still works here.
 */
function leavesCustomRow(map: Keymap, data: string): boolean {
  return matchesKey(data, 'up') || matchesKey(data, 'down')
    || matchesAction(map, 'question.up', data) || matchesAction(map, 'question.down', data)
}

/** One option with the position it answers for, so filtering can drop rows and keep the meaning. */
export interface PositionedOption {
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
    // Abandoning the batch is the one decision that belongs to no row: the
    // reader asked to be out of the questions, and the row the cursor happens
    // to sit on is not an answer to that. It settles the way an aborted call
    // does, with no answers at all, so a partial batch is never handed over as
    // if the reader had walked through it.
    if (matchesAction(this.keys(), 'question.cancel', data)) {
      this.cancel()
      return []
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
    // a skip the reader moved elsewhere must not quietly mean "walk back". The
    // rows the question does own still work here, and the hint names both
    // (customRowExits).
    if (leavesCustomRow(this.keys(), data)) {
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

  /**
   * The card this gate would draw, assembled as a snapshot for the projector.
   *
   * The window, the filter, and the chosen labels are read here, once, so the
   * projector cannot observe a gate that moved on between two of its reads.
   */
  card(): GateCard {
    const question = this.current
    if (question === undefined) {
      return questionCard({
        question: undefined,
        position: this.index + 1,
        total: this.questions.length,
        chosen: [],
        typed: '',
        atCustom: false,
        written: false,
        matched: [],
        rows: [],
        start: 0,
        cursor: 0,
        keys: this.keys(),
        input: this.input,
      })
    }
    const matched = this.matched(question)
    const { rows, start, cursor } = this.windowed(question)
    return questionCard({
      question,
      position: this.index + 1,
      total: this.questions.length,
      chosen: this.chosen[this.index] ?? [],
      typed: this.typed,
      atCustom: this.atCustom,
      // The editor holds the answer, so whether one has been written is its own
      // answer to give; the card only decides where to draw it.
      written: this.input.getExpandedText() !== '',
      matched,
      rows,
      start,
      cursor,
      keys: this.keys(),
      input: this.input,
    })
  }
}
