import { type TUI } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { ApprovalGate, type GateQuestion, QuestionGate, toGateQuestions } from '@/gates.ts'
import { createTheme } from '@/theme.ts'
import { GateInputBar } from '@/ui/gate-input.ts'

/**
 * The terminal the bar renders against. Nothing in these tests reads the screen
 * size or repaints, so the bar under test is the real component over a stub.
 */
const STUB_TUI = { requestRender: () => {}, terminal: { rows: 24, cols: 80 } } as unknown as TUI

/** The bar a gate collects its answers with, which the surface lends it. */
const answerBar = (): GateInputBar => new GateInputBar(STUB_TUI, createTheme('none').editor)

/** A question gate over a fresh bar, which is how the surface builds one. */
const gateOver = (questions: readonly GateQuestion[]): QuestionGate => new QuestionGate(questions, answerBar())

/** What the bar holds, which is what an enter sends. */
const answerText = (gate: QuestionGate): string | undefined => gate.card().answerInput?.getExpandedText()

/** What the bar draws, which is how the answer reaches the reader. */
const answerRows = (gate: QuestionGate): string => gate.card().answerInput?.render(60).join('\n') ?? ''

const ESC = '\x1b'
const ENTER = '\r'
const UP = '\x1b[A'
const LEFT = '\x1b[D'
const DOWN = '\x1b[B'
const BACKSPACE = '\x7f'

describe('ApprovalGate', () => {
  it('allows once on y and rejects on n', () => {
    expect(new ApprovalGate('bash', 'needs network').handleKey('y')).toBe('allowed-once')
    expect(new ApprovalGate('bash', undefined).handleKey('n')).toBe('rejected')
  })

  it('treats escape as a cancellation rather than a silent allow', () => {
    expect(new ApprovalGate('bash', undefined).handleKey(ESC)).toBe('cancelled')
  })

  it('ignores keys that are not decisions', () => {
    const gate = new ApprovalGate('bash', undefined)
    expect(gate.handleKey('x')).toBeUndefined()
    expect(gate.resolved).toBe(false)
  })

  it('settles only once', () => {
    const gate = new ApprovalGate('bash', undefined)
    expect(gate.handleKey('y')).toBe('allowed-once')
    expect(gate.handleKey('n')).toBeUndefined()
    expect(gate.resolved).toBe(true)
  })

  it('lets an abort cancel a request nobody answered', () => {
    const gate = new ApprovalGate('bash', undefined)
    gate.cancel()
    expect(gate.resolved).toBe(true)
    expect(gate.handleKey('y')).toBeUndefined()
  })

  it('shows the tool, the reason, and the keys that decide', () => {
    const card = new ApprovalGate('bash', 'write outside the workspace').card()
    expect(card.kind).toBe('approval')
    expect(card.title).toBe('approval needed · bash')
    expect(card.detail).toEqual(['write outside the workspace'])
    expect(card.hint).toContain('y allow once')
  })
})

describe('toGateQuestions', () => {
  it('reads questions, options, multi-select flags, and the caller heading', () => {
    const questions = toGateQuestions({
      questions: [{
        id: 'q1',
        question: 'which?',
        header: 'Sign in',
        detail: 'pick one',
        options: [{ label: 'a', description: 'first' }],
        multiSelect: true,
      }],
    })
    expect(questions).toEqual([
      { id: 'q1', question: 'which?', header: 'Sign in', detail: 'pick one', options: [{ label: 'a', description: 'first' }], multiSelect: true },
    ])
  })

  it('skips malformed entries and keeps option-less questions answerable by typing', () => {
    const questions = toGateQuestions({ questions: [{ question: 'no id' }, { id: 'q2', question: 'free form' }] })
    expect(questions).toEqual([{ id: 'q2', question: 'free form', header: undefined, detail: undefined, options: [], multiSelect: false }])
  })

  it('returns nothing for a request with no question list', () => {
    expect(toGateQuestions({})).toEqual([])
    expect(toGateQuestions(undefined)).toEqual([])
  })
})

describe('QuestionGate', () => {
  const single = toGateQuestions({
    questions: [{ id: 'q1', question: 'deploy?', options: [{ label: 'yes' }, { label: 'no' }] }],
  })
  const multi = toGateQuestions({
    questions: [{ id: 'q1', question: 'pick', options: [{ label: 'a' }, { label: 'b' }], multiSelect: true }],
  })

  it('selects with a digit and confirms with enter', () => {
    const gate = gateOver(single)
    expect(gate.handleKey('2')).toBeUndefined()
    expect(gate.handleKey(ENTER)).toEqual([{ id: 'q1', selected: ['no'] }])
  })

  it('moves the cursor and selects with space', () => {
    const gate = gateOver(single)
    gate.handleKey(DOWN)
    gate.handleKey(' ')
    expect(gate.handleKey(ENTER)).toEqual([{ id: 'q1', selected: ['no'] }])
  })

  it('replaces the selection for a single-select question and accumulates for multi-select', () => {
    const replacement = gateOver(single)
    replacement.handleKey('1')
    replacement.handleKey('2')
    expect(replacement.handleKey(ENTER)).toEqual([{ id: 'q1', selected: ['no'] }])

    const accumulation = gateOver(multi)
    accumulation.handleKey('1')
    accumulation.handleKey('2')
    expect(accumulation.handleKey(ENTER)).toEqual([{ id: 'q1', selected: ['a', 'b'] }])
  })

  it('skips the current question on escape with an empty selection', () => {
    const gate = gateOver(single)
    expect(gate.handleKey(ESC)).toEqual([{ id: 'q1', selected: [] }])
  })

  it('answers an option-less question with typed text', () => {
    const gate = gateOver(toGateQuestions({ questions: [{ id: 'q1', question: 'why?' }] }))
    for (const character of 'because') gate.handleKey(character)
    gate.handleKey(' ')
    gate.handleKey('x')
    expect(gate.handleKey(BACKSPACE)).toBeUndefined()
    // The trailing space is trimmed when the answer is confirmed.
    expect(gate.handleKey(ENTER)).toEqual([{ id: 'q1', selected: [], custom: 'because' }])
  })

  it('walks a batch and reports progress', () => {
    const gate = gateOver(toGateQuestions({
      questions: [{ id: 'a', question: 'first' }, { id: 'b', question: 'second', options: [{ label: 'x' }] }],
    }))
    expect(gate.card().title).toBe('first  (1/2)')
    expect(gate.handleKey(ENTER)).toBeUndefined()
    expect(gate.card().title).toBe('second  (2/2)')
    gate.handleKey('1')
    expect(gate.handleKey(ENTER)).toEqual([
      { id: 'a', selected: [] },
      { id: 'b', selected: ['x'] },
    ])
    expect(gate.resolved).toBe(true)
  })

  it('marks the cursor and the chosen rows in the card', () => {
    const gate = gateOver(single)
    gate.handleKey('1')
    const card = gate.card()
    expect(card.options.map(option => [option.label, option.current, option.selected])).toEqual([
      ['yes', true, true],
      ['no', false, false],
    ])
    expect(card.hint).toContain('digits pick')
  })
})

/** A picker's question: several providers, two of them sharing a name. */
function providerGate(): QuestionGate {
  return gateOver(toGateQuestions({
    questions: [{
      id: 'q1',
      question: 'which provider?',
      options: [
        { label: 'ChatGPT (Codex)', description: 'openai-codex' },
        { label: 'Anthropic (Claude Pro/Max)', description: 'anthropic' },
        { label: 'Anthropic (Anthropic API key)', description: 'anthropic' },
        { label: 'OpenCode Go', description: 'opencode-go' },
      ],
    }],
  }))
}

describe('QuestionGate filtering', () => {
  it('narrows the options as the reader types', () => {
    const gate = providerGate()
    for (const character of 'anth') gate.handleKey(character)
    expect(gate.card().options.map(option => option.label)).toEqual([
      'Anthropic (Claude Pro/Max)',
      'Anthropic (Anthropic API key)',
    ])
    expect(gate.card().detail.join('\n')).toContain('filter: anth')
    expect(gate.card().hint).toContain('type to filter')
  })

  it('narrows by a scattered fragment, so a name need not be typed whole', () => {
    const gate = providerGate()
    for (const character of 'gptcdx') gate.handleKey(character)
    expect(gate.card().options.map(option => option.label)).toEqual(['ChatGPT (Codex)'])
  })

  it('takes the row the filter left under the cursor on enter', () => {
    const gate = providerGate()
    for (const character of 'codex') gate.handleKey(character)
    expect(gate.handleKey(ENTER)).toEqual([{ id: 'q1', selected: ['ChatGPT (Codex)'] }])
  })

  it('answers with the typed text when the filter holds nothing, so a pasted id still names a row', () => {
    const gate = providerGate()
    for (const character of 'zzz') gate.handleKey(character)
    expect(gate.card().options).toEqual([])
    expect(gate.handleKey(ENTER)).toEqual([{ id: 'q1', selected: [], custom: 'zzz' }])
  })

  it('keeps a number inside the answer of a question without options', () => {
    const gate = gateOver(toGateQuestions({ questions: [{ id: 'q1', question: 'key?' }] }))
    for (const character of 'sk-2') gate.handleKey(character)
    expect(gate.handleKey(ENTER)).toEqual([{ id: 'q1', selected: [], custom: 'sk-2' }])
  })

  it('shows a window of a list longer than the screen, and says which part it shows', () => {
    const many = toGateQuestions({
      questions: [{
        id: 'q1',
        question: 'pick',
        options: Array.from({ length: 30 }, (_, index) => ({ label: `option ${index + 1}` })),
      }],
    })
    const gate = gateOver(many)
    expect(gate.card().options.length).toBe(12)
    expect(gate.card().detail.join('\n')).toContain('showing 1–12 of 30')
    gate.handleKey('1')
    expect(gate.handleKey(ENTER)).toEqual([{ id: 'q1', selected: ['option 1'] }])
  })

  it('counts through the window, so a drawn number still names the option a digit picks', () => {
    const many = toGateQuestions({
      questions: [{
        id: 'q1',
        question: 'pick',
        options: Array.from({ length: 30 }, (_, index) => ({ label: `option ${index + 1}` })),
      }],
    })
    const gate = gateOver(many)
    expect(gate.card().optionOffset).toBe(0)
    for (let step = 0; step < 20; step += 1) gate.handleKey(DOWN)
    const scrolled = gate.card()
    expect(scrolled.detail.join('\n')).toContain('showing 15–26 of 30')
    expect(scrolled.optionOffset).toBe(14)
    gate.handleKey('1')
    expect(gate.handleKey(ENTER)).toEqual([{ id: 'q1', selected: ['option 1'] }])
  })
})

describe('QuestionGate paste', () => {
  const paste = (text: string): string => `\x1b[200~${text}\x1b[201~`

  it('takes a pasted key as the whole answer instead of dropping it', () => {
    const gate = gateOver(toGateQuestions({ questions: [{ id: 'q1', question: 'key?' }] }))
    expect(gate.handleKey(paste('sk-ant-api03-abcDEF123\r\n'))).toBeUndefined()
    // The paste brings its own trailing newline; it is the answer's edge, not
    // its content, so the bar holds it and confirm trims it.
    expect(answerText(gate)?.trim()).toBe('sk-ant-api03-abcDEF123')
    expect(gate.handleKey(ENTER)).toEqual([{ id: 'q1', selected: [], custom: 'sk-ant-api03-abcDEF123' }])
  })

  it('shows an answer no question declared a credential, even when its wording says key', () => {
    // Wording is not a declaration: a question that merely mentions a key would
    // otherwise hide an answer its author meant the reader to check.
    const gate = gateOver(toGateQuestions({ questions: [{ id: 'q1', question: 'Enter the Anthropic API key' }] }))
    gate.handleKey(paste('sk-ant-api03-FAKE998877665544332211'))
    expect(answerText(gate)).toBe('sk-ant-api03-FAKE998877665544332211')
    expect(answerRows(gate)).toContain('FAKE9988')
  })

  it('hides the middle of an answer the question declares a credential', () => {
    const gate = gateOver(toGateQuestions({ questions: [{ id: 'prompt:secret', question: 'Enter the value' }] }))
    gate.handleKey(paste('sk-ant-api03-FAKE998877665544332211'))
    expect(answerText(gate)).toBe('sk-ant-api03-FAKE998877665544332211')
    expect(answerRows(gate)).toContain('sk-a')
    expect(answerRows(gate)).toContain('2211')
    expect(answerRows(gate)).not.toContain('FAKE9988')
  })

  it('names the free-text row after what a declared answer is', () => {
    const gate = gateOver(toGateQuestions({
      questions: [{ id: 'prompt:secret', question: 'Enter the value', options: [{ label: 'one' }, { label: 'two' }] }],
    }))
    expect(gate.card().custom?.label).toBe('API KEY')
  })

  it('gives the bar back its plain mode for the question after a credential', () => {
    const gate = gateOver(toGateQuestions({ questions: [
      { id: 'prompt:secret', question: 'Enter the value' },
      { id: 'q2', question: 'Which branch should I use?' },
    ] }))
    gate.handleKey(paste('sk-ant-api03-FAKE998877665544332211'))
    expect(answerRows(gate)).not.toContain('FAKE9988')
    gate.handleKey(ENTER)
    gate.handleKey(paste('release/0.2'))
    expect(answerRows(gate)).toContain('release/0.2')
  })

  it('shows a plain answer as typed, because an answer is not filtered through the gate', () => {
    const gate = gateOver(toGateQuestions({ questions: [{ id: 'q1', question: 'Which branch should I use?' }] }))
    gate.handleKey(paste('release/0.2'))
    expect(answerText(gate)).toBe('release/0.2')
    expect(answerRows(gate)).toContain('release/0.2')
  })

  it('filters the options from a pasted provider name', () => {
    const gate = providerGate()
    gate.handleKey(paste('Claude Pro'))
    expect(gate.card().options.map(option => option.label)).toEqual(['Anthropic (Claude Pro/Max)'])
  })

  it('draws the bar before anything is typed, so a key has somewhere to land', () => {
    const gate = gateOver(toGateQuestions({ questions: [{ id: 'q1', question: 'key?' }] }))
    expect(answerText(gate)).toBe('')
    expect(answerRows(gate).length).toBeGreaterThan(0)
    expect(gate.card().hint).toContain('paste')
  })

  it('leads with the heading the caller sent, which the seam promises and a plugin relies on', () => {
    const gate = gateOver(toGateQuestions({ questions: [{ id: 'q1', question: 'why?', header: 'Sign in' }] }))
    expect(gate.card().title).toBe('Sign in · why?')
  })
})

/**
 * Row 0 is the free-text answer.
 *
 * A question that lists options otherwise offers no visible way to answer with
 * anything the model did not think of, and the seam already carries that answer
 * as `custom`: the row is how a reader reaches it without guessing.
 */
describe('QuestionGate free-text row', () => {
  const paste = (text: string): string => `\x1b[200~${text}\x1b[201~`

  const withOptions = (): QuestionGate => gateOver(toGateQuestions({
    questions: [{ id: 'q1', question: 'deploy?', options: [{ label: 'yes' }, { label: 'no' }] }],
  }))

  it('offers row 0 on every question that has options', () => {
    expect(withOptions().card().custom).toEqual({
      label: 'other',
      description: 'type your own answer',
      current: false,
      selected: false,
    })
  })

  it('takes the cursor onto row 0 with the zero key', () => {
    const gate = withOptions()
    expect(gate.handleKey('0')).toBeUndefined()
    const card = gate.card()
    expect(card.custom?.current).toBe(true)
    expect(card.options.every(option => !option.current)).toBe(true)
    expect(card.hint).toContain('back to options')
  })

  it('answers with what was typed on row 0 instead of filtering by it', () => {
    const gate = withOptions()
    gate.handleKey('0')
    for (const character of 'ship it') gate.handleKey(character)
    expect(gate.card().options.map(option => option.label)).toEqual(['yes', 'no'])
    expect(answerText(gate)).toBe('ship it')
    expect(gate.handleKey(ENTER)).toEqual([{ id: 'q1', selected: [], custom: 'ship it' }])
  })

  it('reaches row 0 past the last option and keeps the text when the cursor walks back', () => {
    const gate = withOptions()
    gate.handleKey(DOWN)
    // Walking past the last option is the second way onto row 0.
    gate.handleKey(DOWN)
    expect(gate.card().custom?.current).toBe(true)
    for (const character of 'later') gate.handleKey(character)
    gate.handleKey(UP)
    const card = gate.card()
    expect(card.custom).toMatchObject({ current: false, selected: true })
    expect(card.options.find(option => option.current)?.label).toBe('no')
    expect(gate.handleKey(ENTER)).toEqual([{ id: 'q1', selected: [], custom: 'later' }])
  })

  it('lets row 0 override the label a single-select question already chose', () => {
    const gate = withOptions()
    gate.handleKey('1')
    gate.handleKey('0')
    gate.handleKey('m')
    expect(gate.handleKey(ENTER)).toEqual([{ id: 'q1', selected: [], custom: 'm' }])
  })

  it('supplements the labels a multi-select question chose', () => {
    const gate = gateOver(toGateQuestions({
      questions: [{ id: 'q1', question: 'pick', options: [{ label: 'a' }, { label: 'b' }], multiSelect: true }],
    }))
    gate.handleKey('1')
    gate.handleKey('0')
    gate.handleKey('x')
    expect(gate.handleKey(ENTER)).toEqual([{ id: 'q1', selected: ['a'], custom: 'x' }])
  })

  it('confirms what is already chosen when row 0 holds nothing, rather than a hidden row', () => {
    const gate = withOptions()
    gate.handleKey('2')
    gate.handleKey('0')
    expect(gate.handleKey(ENTER)).toEqual([{ id: 'q1', selected: ['no'] }])
  })

  it('types a space and a digit on row 0 instead of acting on the list', () => {
    const gate = withOptions()
    gate.handleKey('0')
    for (const character of 'v2 two') gate.handleKey(character)
    expect(gate.handleKey(ENTER)).toEqual([{ id: 'q1', selected: [], custom: 'v2 two' }])
  })

  it('keeps a pasted answer on row 0 and sends it whole', () => {
    const gate = gateOver(toGateQuestions({
      questions: [{ id: 'q1', question: 'Which key should the deploy use?', options: [{ label: 'from the vault' }] }],
    }))
    gate.handleKey('0')
    gate.handleKey(paste('sk-ant-api03-FAKE998877665544332211'))
    expect(answerText(gate)).toBe('sk-ant-api03-FAKE998877665544332211')
    expect(answerRows(gate)).toContain('FAKE9988')
    expect(gate.handleKey(ENTER)).toEqual([{ id: 'q1', selected: [], custom: 'sk-ant-api03-FAKE998877665544332211' }])
  })

  it('draws row 0 even when the filter leaves no option to show', () => {
    const gate = withOptions()
    for (const character of 'zzz') gate.handleKey(character)
    const card = gate.card()
    expect(card.options).toEqual([])
    expect(card.custom).toMatchObject({ current: false, selected: false })
  })

  it('leaves the free-text row on escape, and skips only from the list', () => {
    // A question skipped by accident is a question the reader answers again, so
    // an escape out of the text they are writing is not an escape from the
    // question: the list it returns to is where a question is skipped.
    const typed = withOptions()
    typed.handleKey('0')
    typed.handleKey('x')
    expect(typed.handleKey(ESC)).toBeUndefined()
    expect(typed.card().custom).toMatchObject({ current: false, selected: true })
    expect(answerText(typed)).toBe('x')
    expect(typed.handleKey(ESC)).toEqual([{ id: 'q1', selected: [] }])
  })

  it('returns the cursor to the row the free-text row was entered from', () => {
    const gate = providerGate()
    gate.handleKey('down')
    gate.handleKey('down')
    const left = gate.card().options.find(option => option.current)?.label
    expect(left).toBeDefined()
    gate.handleKey('0')
    expect(gate.card().custom).toMatchObject({ current: true })
    // The text stays where it was written, so answering freely again resumes it.
    gate.handleKey('later')
    gate.handleKey(ESC)
    expect(gate.card().options.find(option => option.current)?.label).toBe(left)
    gate.handleKey('0')
    expect(answerText(gate)).toBe('later')
  })

  it('returns to the row a digit picked, which the cursor never walked to', () => {
    const gate = providerGate()
    gate.handleKey('2')
    expect(gate.card().options.find(option => option.current)?.label).toBe('ChatGPT (Codex)')
    expect(gate.card().options.find(option => option.selected)?.label).toBe('Anthropic (Claude Pro/Max)')
    gate.handleKey('0')
    gate.handleKey(ESC)
    expect(gate.card().options.find(option => option.current)?.label).toBe('Anthropic (Claude Pro/Max)')
  })

  it('skips a question that is nothing but text on the first escape', () => {
    // Such a question has no list to return to, so an escape has nowhere else to go.
    const freeform = gateOver(toGateQuestions({ questions: [{ id: 'q1', question: 'why?' }] }))
    for (const character of 'because') freeform.handleKey(character)
    expect(freeform.handleKey(ESC)).toEqual([{ id: 'q1', selected: [] }])
  })

  it('starts the next question of a batch with an empty row 0', () => {
    const gate = gateOver(toGateQuestions({
      questions: [
        { id: 'a', question: 'first', options: [{ label: 'x' }] },
        { id: 'b', question: 'second', options: [{ label: 'y' }] },
      ],
    }))
    gate.handleKey('0')
    gate.handleKey('m')
    gate.handleKey(ENTER)
    const card = gate.card()
    expect(card.custom).toEqual({ label: 'other', description: 'type your own answer', current: false, selected: false })
    // Nothing is written into the next question, so its bar is not drawn yet.
    expect(card.answerInput).toBeUndefined()
  })

  it('shows the answer to a question that only mentions keys', () => {
    const gate = gateOver(toGateQuestions({
      questions: [{
        id: 'q1',
        question: 'Which keys should the shortcut row use? Paste your verdict.',
        options: [{ label: 'ctrl+t' }],
      }],
    }))
    gate.handleKey('0')
    for (const character of 'the keys line') gate.handleKey(character)
    expect(answerText(gate)).toBe('the keys line')
    expect(answerRows(gate)).toContain('the keys line')
  })

  it('shows the answer to a question that names a keybinding', () => {
    const gate = gateOver(toGateQuestions({ questions: [{ id: 'q1', question: 'Which keybinding should I use?' }] }))
    for (const character of 'ctrl+t') gate.handleKey(character)
    expect(answerText(gate)).toBe('ctrl+t')
    expect(answerRows(gate)).toContain('ctrl+t')
  })

  it('draws what a question about credentials collects', () => {
    const gate = gateOver(toGateQuestions({
      questions: [{ id: 'q1', question: 'Paste the deploy credentials, then pick the vault', options: [{ label: 'from the vault' }] }],
    }))
    gate.handleKey('0')
    gate.handleKey(paste('abcdefghijkl'))
    expect(answerText(gate)).toBe('abcdefghijkl')
    expect(answerRows(gate)).toContain('abcdefghijkl')
  })

  it('hands the typed answer to the bar, not to the question detail', () => {
    const gate = withOptions()
    gate.handleKey('0')
    for (const character of 'later') gate.handleKey(character)
    const card = gate.card()
    expect(card.answerInput).toBeDefined()
    expect(answerText(gate)).toBe('later')
    // The detail block is drawn above the options, where the line would read as
    // something the question says rather than something the reader is typing.
    expect(card.detail.some(line => line.includes('later'))).toBe(false)
  })

  it('carries the bar of a question that has only text to collect', () => {
    const gate = gateOver(toGateQuestions({ questions: [{ id: 'q1', question: 'why?' }] }))
    expect(gate.card().answerInput).toBeDefined()
    expect(answerText(gate)).toBe('')
    expect(gate.card().detail).toEqual([])
  })

  it('edits the answer with the whole editor rather than at its end', () => {
    const gate = withOptions()
    gate.handleKey('0')
    for (const character of 'later') gate.handleKey(character)
    gate.handleKey(LEFT)
    gate.handleKey(LEFT)
    gate.handleKey('X')
    expect(answerText(gate)).toBe('latXer')
    expect(gate.handleKey(ENTER)).toEqual([{ id: 'q1', selected: [], custom: 'latXer' }])
  })

  it('opens a question over a bar that still holds the last answer as empty', () => {
    // The bar outlives one gate, so a question opened after an abandoned answer
    // must not inherit it: the reader sees an empty bar and sends what they type.
    const bar = answerBar()
    bar.setText('an answer nobody sent')
    const gate = new QuestionGate(toGateQuestions({
      questions: [{ id: 'q1', question: 'why?', options: [{ label: 'because' }] }],
    }), bar)
    expect(gate.card().answerInput).toBeUndefined()
    gate.handleKey('0')
    expect(answerText(gate)).toBe('')
  })

  it('takes a multi-line paste as one answer', () => {
    const gate = gateOver(toGateQuestions({ questions: [{ id: 'q1', question: 'why?' }] }))
    gate.handleKey(paste('first line\nsecond line'))
    expect(answerText(gate)).toBe('first line\nsecond line')
    expect(gate.handleKey(ENTER)).toEqual([{ id: 'q1', selected: [], custom: 'first line\nsecond line' }])
  })

  it('leaves a question without options to typing, with no row 0 to reach', () => {
    const gate = gateOver(toGateQuestions({ questions: [{ id: 'q1', question: 'why?' }] }))
    expect(gate.card().custom).toBeUndefined()
    for (const character of 'because') gate.handleKey(character)
    expect(gate.handleKey(ENTER)).toEqual([{ id: 'q1', selected: [], custom: 'because' }])
  })
})
