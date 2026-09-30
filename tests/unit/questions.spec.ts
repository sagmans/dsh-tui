/**
 * The question gate: cursor and selection transitions across a batch, and what
 * a filter leaves under the cursor.
 */

import { describe, expect, it } from 'vitest'
import { QuestionGate, toGateQuestions } from '@/gates/questions.ts'
import { resolveKeymap } from '@/input/actions.ts'
import { gateOver, ESC, ENTER, DOWN, BACKSPACE, CTRL_C, CTRL_P, CTRL_N, providerGate } from './fixtures/gate.ts'


describe('QuestionGate', () => {
  const single = toGateQuestions({
      questions: [{ id: 'q1', question: 'deploy?', options: [{ label: 'yes' }, { label: 'no' }] }],
    })
  const multi = toGateQuestions({
      questions: [{ id: 'q1', question: 'pick', options: [{ label: 'a' }, { label: 'b' }], multiSelect: true }],
    })
  it.each(['😀', 'a\u0308', '\x1b[128512;1u'])('filters Unicode text without losing the option %j', data => {
    const gate = gateOver(toGateQuestions({
      questions: [{ id: 'q1', question: 'which?', options: [{ label: '😀 a\u0308 choice' }, { label: 'other' }] }],
    }))
    gate.handleKey(data)
    expect(gate.card().options.map(row => row.label)).toEqual(['😀 a\u0308 choice'])
    gate.handleKey(BACKSPACE)
    expect(gate.card().options).toHaveLength(2)
  })

  it('selects an encoded digit exactly like its legacy key', () => {
    const gate = gateOver(single)
    gate.handleKey('\x1b[49;1u')
    expect(gate.card().options[0]?.selected).toBe(true)
  })

  it('moves the cursor and selects with space', () => {
      const gate = gateOver(single)
      gate.handleKey(DOWN)
      gate.handleKey(' ')
      // The row the cursor walked to is the row the space has to mark: without
      // that, enter would still answer it from the cursor and a dead toggle
      // would read as a working one.
      expect(gate.card().options[1]).toMatchObject({ label: 'no', current: true, selected: true })
      expect(gate.handleKey(ENTER)).toEqual([{ id: 'q1', selected: ['no'] }])
    })
  it('moves on the Ctrl+P and Ctrl+N aliases as well as the arrows', () => {
      const down = gateOver(single)
      down.handleKey(CTRL_N)
      down.handleKey(' ')
      expect(down.handleKey(ENTER)).toEqual([{ id: 'q1', selected: ['no'] }])
  
      const up = gateOver(single)
      up.handleKey(DOWN)
      up.handleKey(CTRL_P)
      up.handleKey(' ')
      expect(up.handleKey(ENTER)).toEqual([{ id: 'q1', selected: ['yes'] }])
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
  it('moves, picks, and answers on the keys the reader chose', () => {
      const map = resolveKeymap({
        'question.up': 'alt+u',
        'question.down': 'alt+d',
        'question.toggle': 'alt+t',
        'question.confirm': 'alt+y',
        'question.skip': 'alt+g',
      })
      const gate = gateOver(single, () => map)
      expect(gate.card().hint).toContain('alt+t select')
      gate.handleKey('\u001bd')
      gate.handleKey('\u001bt')
      expect(gate.handleKey(ESC)).toBeUndefined()
      expect(gate.handleKey('\u001by')).toEqual([{ id: 'q1', selected: ['no'] }])
    })
  it('skips only on the key the reader kept for skipping', () => {
      const map = resolveKeymap({ 'question.skip': 'alt+g' })
      const gate = gateOver(single, () => map)
      expect(gate.handleKey(ESC)).toBeUndefined()
      expect(gate.handleKey('\u001bg')).toEqual([{ id: 'q1', selected: [] }])
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
  it('abandons the whole batch on the interrupt key, answering nothing', () => {
      // Escape skips one question; this says the reader is done with all of them,
      // so the caller gets the same empty batch an aborted call produces.
      const gate = gateOver(toGateQuestions({
        questions: [{ id: 'a', question: 'first', options: [{ label: 'x' }] }, { id: 'b', question: 'second' }],
      }))
      gate.handleKey('1')
      expect(gate.handleKey(CTRL_C)).toEqual([])
      expect(gate.resolved).toBe(true)
    })
  it('abandons from the free-text row too, where the other keys belong to the bar', () => {
      const gate = gateOver(single)
      gate.handleKey('0')
      expect(gate.card().answerInput).toBeDefined()
      expect(gate.handleKey(CTRL_C)).toEqual([])
    })
  it('abandons on the key the reader moved the cancel onto', () => {
      const map = resolveKeymap({ 'question.cancel': 'alt+c' })
      const gate = gateOver(single, () => map)
      expect(gate.handleKey(CTRL_C)).toBeUndefined()
      expect(gate.handleKey('\u001bc')).toEqual([])
    })
  it('names the abandon key wherever it is answered', () => {
      expect(gateOver(single).card().hint).toContain('ctrl+c abandon')
      const custom = gateOver(single)
      custom.handleKey('0')
      expect(custom.card().hint).toContain('ctrl+c abandon')
    })
  it('lets an abort cancel a question nobody answered', () => {
      const gate = gateOver(single)
      gate.cancel()
      expect(gate.resolved).toBe(true)
      expect(gate.handleKey(ENTER)).toBeUndefined()
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
      // A filter takes the text inside the paste rather than the sequence, which
      // is the path a reader pasting an id the list does not hold takes.
      gate.handleKey('\u001b[200~zzz\u001b[201~')
      expect(gate.card().options).toEqual([])
      expect(gate.handleKey(ENTER)).toEqual([{ id: 'q1', selected: [], custom: 'zzz' }])
    })
  it('keeps a number inside the answer of a question without options', () => {
      const gate = gateOver(toGateQuestions({ questions: [{ id: 'q1', question: 'key?' }] }))
      for (const character of 'sk-2') gate.handleKey(character)
      expect(gate.handleKey(ENTER)).toEqual([{ id: 'q1', selected: [], custom: 'sk-2' }])
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
      // Forty options do not fit a card, so the window is what the reader sees:
      // twelve rows, and the part of the list they are drawn from.
      expect(gate.card().options).toHaveLength(12)
      expect(gate.card().detail.join('\n')).toContain('showing 1–12 of 30')
      expect(gate.card().optionOffset).toBe(0)
      for (let step = 0; step < 20; step += 1) gate.handleKey(DOWN)
      const scrolled = gate.card()
      expect(scrolled.detail.join('\n')).toContain('showing 15–26 of 30')
      expect(scrolled.optionOffset).toBe(14)
      gate.handleKey('1')
      expect(gate.handleKey(ENTER)).toEqual([{ id: 'q1', selected: ['option 1'] }])
    })
})

/**
 * The untrusted seam: the payload a harness asks with is decoded here, so the
 * gate only ever sees rows it can draw and answer.
 */
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

