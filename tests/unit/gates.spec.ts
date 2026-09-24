/**
 * The approval gate and request decoding: the keys that decide, the keys that
 * cancel, and the card the caller reads back.
 */

import { describe, expect, it } from 'vitest'
import { ApprovalGate } from '@/gates.ts'
import { toGateQuestions } from '@/gates/questions.ts'
import { defaultKeymap, resolveKeymap } from '@/input/actions.ts'
import { ESC, CTRL_C } from './fixtures/gate.ts'


describe('ApprovalGate', () => {
  it('allows once on y and rejects on n', () => {
      expect(new ApprovalGate('bash', 'needs network', defaultKeymap).handleKey('y')).toBe('allowed-once')
      expect(new ApprovalGate('bash', undefined, defaultKeymap).handleKey('n')).toBe('rejected')
    })
  it('treats escape as a cancellation rather than a silent allow', () => {
      expect(new ApprovalGate('bash', undefined, defaultKeymap).handleKey(ESC)).toBe('cancelled')
    })
  it('cancels on the interrupt key as well, which the surface answers with', () => {
      expect(new ApprovalGate('bash', undefined, defaultKeymap).handleKey(CTRL_C)).toBe('cancelled')
    })
  it('ignores keys that are not decisions', () => {
      const gate = new ApprovalGate('bash', undefined, defaultKeymap)
      expect(gate.handleKey('x')).toBeUndefined()
      expect(gate.resolved).toBe(false)
    })
  it('settles only once', () => {
      const gate = new ApprovalGate('bash', undefined, defaultKeymap)
      expect(gate.handleKey('y')).toBe('allowed-once')
      expect(gate.handleKey('n')).toBeUndefined()
      expect(gate.resolved).toBe(true)
    })
  it('lets an abort cancel a request nobody answered', () => {
      const gate = new ApprovalGate('bash', undefined, defaultKeymap)
      gate.cancel()
      expect(gate.resolved).toBe(true)
      expect(gate.handleKey('y')).toBeUndefined()
    })
  it('decides on the keys the reader chose, and names those in its card', () => {
      const map = resolveKeymap({ 'gate.allow': 'a', 'gate.reject': 'r', 'gate.cancel': 'alt+g' })
      const gate = new ApprovalGate('bash', undefined, () => map)
      expect(gate.card().hint).toBe('a allow once · r reject · alt+g cancel')
      expect(gate.handleKey('y')).toBeUndefined()
      expect(gate.handleKey('a')).toBe('allowed-once')
    })
  it('shows the tool, the reason, and the keys that decide', () => {
      const card = new ApprovalGate('bash', 'write outside the workspace', defaultKeymap).card()
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
