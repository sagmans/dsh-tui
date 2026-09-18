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
  it('reads questions, options, and multi-select flags', () => {
    const questions = toGateQuestions({
      questions: [{ id: 'q1', question: 'which?', detail: 'pick one', options: [{ label: 'a', description: 'first' }], multiSelect: true }],
    })
    expect(questions).toEqual([
      { id: 'q1', question: 'which?', detail: 'pick one', options: [{ label: 'a', description: 'first' }], multiSelect: true },
    ])
  })

  it('skips malformed entries and keeps option-less questions answerable by typing', () => {
    const questions = toGateQuestions({ questions: [{ question: 'no id' }, { id: 'q2', question: 'free form' }] })
    expect(questions).toEqual([{ id: 'q2', question: 'free form', detail: undefined, options: [], multiSelect: false }])
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

  it('shows a window of a list longer than the screen', () => {
    const many = toGateQuestions({
      questions: [{
        id: 'q1',
        question: 'pick',
        options: Array.from({ length: 30 }, (_, index) => ({ label: `option ${index + 1}` })),
      }],
    })
    const gate = new QuestionGate(many)
    expect(gate.card().options.length).toBe(12)
    gate.handleKey('1')
    expect(gate.handleKey(ENTER)).toEqual([{ id: 'q1', selected: ['option 1'] }])
  })
})

describe('QuestionGate paste', () => {
  const paste = (text: string): string => `\x1b[200~${text}\x1b[201~`

  it('takes a pasted key as the whole answer instead of dropping it', () => {
    const gate = new QuestionGate(toGateQuestions({ questions: [{ id: 'q1', question: 'key?' }] }))
    expect(gate.handleKey(paste('sk-ant-api03-abcDEF123\r\n'))).toBeUndefined()
    expect(gate.card().detail.join('\n')).toContain('answer: sk-ant-api03-abcDEF123▌')
    expect(gate.handleKey(ENTER)).toEqual([{ id: 'q1', selected: [], custom: 'sk-ant-api03-abcDEF123' }])
  })

  it('filters the options from a pasted provider name', () => {
    const gate = providerGate()
    gate.handleKey(paste('Claude Pro'))
    expect(gate.card().options.map(option => option.label)).toEqual(['Anthropic (Claude Pro/Max)'])
  })

  it('draws the answer row before anything is typed, so a key has somewhere to land', () => {
    const gate = new QuestionGate(toGateQuestions({ questions: [{ id: 'q1', question: 'key?' }] }))
    expect(gate.card().detail.join('\n')).toContain('answer: ▌')
    expect(gate.card().hint).toContain('paste')
  })
})
