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
