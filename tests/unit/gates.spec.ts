import { describe, expect, it } from 'vitest'
import { ApprovalGate, QuestionGate, toGateQuestions } from '@/gates.ts'

const ESC = '\x1b'
const ENTER = '\r'
const UP = '\x1b[A'
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
    const gate = new QuestionGate(single)
    expect(gate.handleKey('2')).toBeUndefined()
    expect(gate.handleKey(ENTER)).toEqual([{ id: 'q1', selected: ['no'] }])
  })

  it('moves the cursor and selects with space', () => {
    const gate = new QuestionGate(single)
    gate.handleKey(DOWN)
    gate.handleKey(' ')
    expect(gate.handleKey(ENTER)).toEqual([{ id: 'q1', selected: ['no'] }])
  })

  it('replaces the selection for a single-select question and accumulates for multi-select', () => {
    const replacement = new QuestionGate(single)
    replacement.handleKey('1')
    replacement.handleKey('2')
    expect(replacement.handleKey(ENTER)).toEqual([{ id: 'q1', selected: ['no'] }])

    const accumulation = new QuestionGate(multi)
    accumulation.handleKey('1')
    accumulation.handleKey('2')
    expect(accumulation.handleKey(ENTER)).toEqual([{ id: 'q1', selected: ['a', 'b'] }])
  })

  it('skips the current question on escape with an empty selection', () => {
    const gate = new QuestionGate(single)
    expect(gate.handleKey(ESC)).toEqual([{ id: 'q1', selected: [] }])
  })

  it('answers an option-less question with typed text', () => {
    const gate = new QuestionGate(toGateQuestions({ questions: [{ id: 'q1', question: 'why?' }] }))
    for (const character of 'because') gate.handleKey(character)
    gate.handleKey(' ')
    gate.handleKey('x')
    expect(gate.handleKey(BACKSPACE)).toBeUndefined()
    // The trailing space is trimmed when the answer is confirmed.
    expect(gate.handleKey(ENTER)).toEqual([{ id: 'q1', selected: [], custom: 'because' }])
  })

  it('walks a batch and reports progress', () => {
    const gate = new QuestionGate(toGateQuestions({
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
    const gate = new QuestionGate(single)
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
  return new QuestionGate(toGateQuestions({
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
    const gate = new QuestionGate(toGateQuestions({ questions: [{ id: 'q1', question: 'key?' }] }))
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
    const gate = new QuestionGate(many)
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
    const gate = new QuestionGate(many)
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
    const gate = new QuestionGate(toGateQuestions({ questions: [{ id: 'q1', question: 'key?' }] }))
    expect(gate.handleKey(paste('sk-ant-api03-abcDEF123\r\n'))).toBeUndefined()
    expect(gate.card().detail.join('\n')).toMatch(/API KEY: sk-a\*+F123▌/u)
    expect(gate.handleKey(ENTER)).toEqual([{ id: 'q1', selected: [], custom: 'sk-ant-api03-abcDEF123' }])
  })

  it('keeps a secret recognizable at both ends and hidden in between', () => {
    const gate = new QuestionGate(toGateQuestions({ questions: [{ id: 'q1', question: 'Enter the Anthropic API key' }] }))
    gate.handleKey(paste('sk-ant-api03-FAKE998877665544332211'))
    const row = gate.card().detail.join('\n')
    expect(row).toMatch(/API KEY: sk-a\*+2211▌/u)
    expect(row).not.toContain('FAKE9988')
  })

  it('shows a plain answer as typed, because hiding everything hides the answer', () => {
    const gate = new QuestionGate(toGateQuestions({ questions: [{ id: 'q1', question: 'Which branch should I use?' }] }))
    gate.handleKey(paste('release/0.2'))
    expect(gate.card().detail.join('\n')).toContain('answer: release/0.2▌')
  })

  it('filters the options from a pasted provider name', () => {
    const gate = providerGate()
    gate.handleKey(paste('Claude Pro'))
    expect(gate.card().options.map(option => option.label)).toEqual(['Anthropic (Claude Pro/Max)'])
  })

  it('draws the answer row before anything is typed, so a key has somewhere to land', () => {
    const gate = new QuestionGate(toGateQuestions({ questions: [{ id: 'q1', question: 'key?' }] }))
    expect(gate.card().detail.join('\n')).toContain('API KEY: ▌')
    expect(gate.card().hint).toContain('paste')
  })

  it('leads with the heading the caller sent, which the seam promises and a plugin relies on', () => {
    const gate = new QuestionGate(toGateQuestions({ questions: [{ id: 'q1', question: 'why?', header: 'Sign in' }] }))
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

  const withOptions = (): QuestionGate => new QuestionGate(toGateQuestions({
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
    expect(card.hint).toContain('↑↓ back to options')
  })

  it('answers with what was typed on row 0 instead of filtering by it', () => {
    const gate = withOptions()
    gate.handleKey('0')
    for (const character of 'ship it') gate.handleKey(character)
    expect(gate.card().options.map(option => option.label)).toEqual(['yes', 'no'])
    expect(gate.card().detail.join('\n')).toContain('answer: ship it▌')
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
    const gate = new QuestionGate(toGateQuestions({
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

  it('keeps a pasted answer on row 0 and hides it when the question asks for a secret', () => {
    const gate = new QuestionGate(toGateQuestions({
      questions: [{ id: 'q1', question: 'API key?', options: [{ label: 'from the vault' }] }],
    }))
    gate.handleKey('0')
    gate.handleKey(paste('sk-ant-api03-FAKE998877665544332211'))
    const row = gate.card().detail.join('\n')
    expect(row).toMatch(/API KEY: sk-a\*+2211▌/u)
    expect(row).not.toContain('FAKE9988')
    expect(gate.handleKey(ENTER)).toEqual([{ id: 'q1', selected: [], custom: 'sk-ant-api03-FAKE998877665544332211' }])
  })

  it('draws row 0 even when the filter leaves no option to show', () => {
    const gate = withOptions()
    for (const character of 'zzz') gate.handleKey(character)
    const card = gate.card()
    expect(card.options).toEqual([])
    expect(card.custom).toMatchObject({ current: false, selected: false })
  })

  it('skips on escape without sending the text it drops', () => {
    const typed = withOptions()
    typed.handleKey('0')
    typed.handleKey('x')
    expect(typed.handleKey(ESC)).toEqual([{ id: 'q1', selected: [] }])

    // An escape means the same thing on a question that is nothing but text.
    const freeform = new QuestionGate(toGateQuestions({ questions: [{ id: 'q1', question: 'why?' }] }))
    for (const character of 'because') freeform.handleKey(character)
    expect(freeform.handleKey(ESC)).toEqual([{ id: 'q1', selected: [] }])
  })

  it('starts the next question of a batch with an empty row 0', () => {
    const gate = new QuestionGate(toGateQuestions({
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
    expect(card.detail.join('\n')).not.toContain('answer:')
  })

  it('leaves a question without options to typing, with no row 0 to reach', () => {
    const gate = new QuestionGate(toGateQuestions({ questions: [{ id: 'q1', question: 'why?' }] }))
    expect(gate.card().custom).toBeUndefined()
    for (const character of 'because') gate.handleKey(character)
    expect(gate.handleKey(ENTER)).toEqual([{ id: 'q1', selected: [], custom: 'because' }])
  })
})
