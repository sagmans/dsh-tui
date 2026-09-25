import { CUSTOM_ROW_NUMBER, lines, type GateCard, type GateInput, type GateQuestion } from '../gates.ts'
import { keyName, keysFor, type Keymap } from '../input/actions.ts'
import type { PositionedOption } from './questions.ts'

/** The label a question earns for an answer the model did not list. */
export const CUSTOM_ROW_LABEL = 'other'

/** What the free-text row does, said where the reader decides. */
export const CUSTOM_ROW_DESCRIPTION = 'type your own answer'

/** How the list hint names that row, which the row itself already labels. */
export const CUSTOM_ROW_SHORTHAND = `${CUSTOM_ROW_NUMBER} answer freely`

/**
 * How a hint names the keys of one action.
 *
 * A hint is prose about what a key does here, so the word comes from the card
 * rather than from the catalog row, which has to read well out of context too.
 */
export function namedKeys(map: Keymap, id: string, verb: string): string {
  // One verb for the action, however many keys reach it: a hint that repeated
  // the word would read as two actions rather than two ways to do one.
  return `${keysFor(map, id).map(keyName).join('/')} ${verb}`
}

/**
 * How the free-text row spells the keys that leave it.
 *
 * A text field keeps its own exits: the arrows and escape are the field's, not
 * the question's, so a reader who moved question.up or question.skip somewhere
 * else still leaves with these. The question's own movement keys leave it as
 * well, which is how the navigation aliases reach a reader who is typing rather
 * than filtering. The arrows stay one token because they are pinned together
 * rather than listed one direction at a time.
 */
export function customRowExits(map: Keymap): string {
  const names = ['↑↓']
  for (const id of ['question.up', 'question.down']) {
    for (const key of keysFor(map, id)) {
      const name = keyName(key)
      if (name !== 'up' && name !== 'down' && !names.includes(name)) names.push(name)
    }
  }
  return names.join('/')
}

/** The keys that answer the free-text row, where typing is the answer rather than a filter. */
export function customHint(map: Keymap): string {
  return `type or paste an answer · ${namedKeys(map, 'question.confirm', 'confirm')} · ${namedKeys(map, 'question.cancel', 'abandon')} · ${customRowExits(map)} or esc to options`
}

/**
 * The question-id suffix that declares a typed answer a credential. The seam
 * has no field for it, so a caller marks its own id and the gate reads that
 * declaration rather than the wording: ids are caller-owned, and a question
 * that merely mentions a key must still show the answer its author meant read.
 */
export const SECRET_ID_SUFFIX = ':secret'

/** The free-text row's label when the answer is a credential, so the reader sees what they hand over. */
export const SECRET_ROW_LABEL = 'API KEY'

/** Whether a question declares its typed answer a credential through its id. */
export function declaresSecret(id: string): boolean {
  return id.endsWith(SECRET_ID_SUFFIX)
}

/**
 * Everything the question card draws, read off the gate at the moment of the
 * call.
 *
 * The projection takes this snapshot rather than the gate itself, so a card
 * cannot reach back into state that moved on while it was being assembled, and
 * a test can describe a screen without building a gate to hold it.
 */
export interface QuestionCardView {
  /** The question on screen, or undefined once every one has been decided. */
  readonly question: GateQuestion | undefined
  /** One-based position of that question among the gate's own. */
  readonly position: number
  /** How many questions the gate asks; the title admits to it only when it is more than one. */
  readonly total: number
  /** Labels already chosen on this question. */
  readonly chosen: readonly string[]
  /** The filter the reader typed, empty when none. */
  readonly typed: string
  /** Whether the cursor is on the free-text row. */
  readonly atCustom: boolean
  /** Whether the editor already holds an answer; the card decides where to draw it. */
  readonly written: boolean
  /** Every option matching the filter, in row order. */
  readonly matched: readonly PositionedOption[]
  /** The slice of those rows the window shows. */
  readonly rows: readonly PositionedOption[]
  /** One-based row number the window starts at, and where the cursor stands in it. */
  readonly start: number
  readonly cursor: number
  /** The keys and the editor in force, read per draw so a settings edit lands on the next frame. */
  readonly keys: Keymap
  readonly input: GateInput
}

/** The card for one question: its heading, its windowed options, the free-text row, and the answer in view. */
export function questionCard(view: QuestionCardView): GateCard {
  const question = view.question
  if (question === undefined) {
    return { kind: 'question', title: 'question', detail: [], optionOffset: 0, options: [], custom: undefined, answerInput: undefined, hint: 'finishing' }
  }
  const detail = question.detail === undefined ? [] : lines(question.detail)
  const heading = question.header === undefined ? '' : question.header + ' · '
  const title = `${heading}${question.question}${view.total > 1 ? `  (${view.position}/${view.total})` : ''}`
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
      answerInput: view.input,
      hint: `type or paste an answer · ${namedKeys(view.keys, 'question.confirm', 'confirm')} · ${namedKeys(view.keys, 'question.skip', 'skip')} · ${namedKeys(view.keys, 'question.cancel', 'abandon')}`,
    }
  }
  if (view.typed !== '') detail.push(`filter: ${view.typed}`)
  const secret = declaresSecret(question.id)
  if (view.rows.length < view.matched.length) detail.push(`showing ${view.start + 1}–${view.start + view.rows.length} of ${view.matched.length}`)
  return {
    kind: 'question',
    title,
    detail,
    optionOffset: view.start,
    options: view.rows.map(({ option }, position) => ({
      label: option.label,
      description: option.description,
      // The free-text row wears the cursor when it holds it: a mark on a row
      // the reader is not pointing at is a mark that lies.
      current: !view.atCustom && view.start + position === view.cursor,
      selected: view.chosen.includes(option.label),
    })),
    custom: {
      label: secret ? SECRET_ROW_LABEL : CUSTOM_ROW_LABEL,
      description: CUSTOM_ROW_DESCRIPTION,
      current: view.atCustom,
      selected: view.atCustom || view.written,
    },
    // A written answer stays in view whether or not the cursor is on the row,
    // because it is what an enter is about to send.
    answerInput: view.atCustom || view.written ? view.input : undefined,
    hint: view.atCustom
      ? customHint(view.keys)
      : `${namedKeys(view.keys, 'question.toggle', question.multiSelect ? 'toggle' : 'select')} · digits pick · ${CUSTOM_ROW_SHORTHAND} · type to filter · ${namedKeys(view.keys, 'question.confirm', 'confirm')} · ${namedKeys(view.keys, 'question.skip', 'skip')} · ${namedKeys(view.keys, 'question.cancel', 'abandon')}`,
  }
}
