/**
 * The free-text row and its paste path: what a declared credential hides, what
 * row 0 answers with, and how an editor keeps its plain mode across questions.
 */

import { describe, expect, it } from 'vitest'
import { type GateQuestion } from '@/gates.ts'
import { QuestionGate, toGateQuestions } from '@/gates/questions.ts'
import { defaultKeymap, resolveKeymap } from '@/input/actions.ts'
import { createAnswerCompletionProvider } from '@/input/completion.ts'
import { answerBar, gateOver, answerText, answerRows, ESC, ENTER, UP, LEFT, DOWN, CTRL_P, providerGate } from './fixtures/gate.ts'


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

describe('QuestionGate free-text row', () => {
  const paste = (text: string): string => `\x1b[200~${text}\x1b[201~`
  const withOptionsQuestion = (): readonly GateQuestion[] => toGateQuestions({
      questions: [{ id: 'q1', question: 'deploy?', options: [{ label: 'yes' }, { label: 'no' }] }],
    })
  const withOptions = (): QuestionGate => gateOver(withOptionsQuestion())
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
      // The hint names the field's own exits and the question's movement keys.
      expect(card.hint).toContain('↑↓/ctrl+p/ctrl+n or esc to options')
    })
  it('leaves row 0 on a navigation alias and keeps what was typed', () => {
      const gate = withOptions()
      gate.handleKey('0')
      for (const character of 'later') gate.handleKey(character)
      expect(gate.handleKey(CTRL_P)).toBeUndefined()
      const card = gate.card()
      expect(card.custom).toMatchObject({ current: false, selected: true })
      expect(gate.handleKey(ENTER)).toEqual([{ id: 'q1', selected: [], custom: 'later' }])
    })
  it('keeps the field arrows leaving row 0 after the question keys move', () => {
      const map = resolveKeymap({ 'question.up': 'alt+u', 'question.down': 'alt+d' })
      const gate = gateOver(withOptionsQuestion(), () => map)
      gate.handleKey('0')
      expect(gate.card().hint).toContain('↑↓/alt+u/alt+d')
      expect(gate.handleKey(DOWN)).toBeUndefined()
      const card = gate.card()
      expect(card.custom?.current).toBe(false)
      expect(card.options[0]?.current).toBe(true)
    })
  it('leaves row 0 on the question keys the reader chose', () => {
      const map = resolveKeymap({ 'question.up': 'alt+u', 'question.down': 'alt+d' })
      const gate = gateOver(withOptionsQuestion(), () => map)
      gate.handleKey('0')
      expect(gate.handleKey('\u001bd')).toBeUndefined()
      expect(gate.card().custom?.current).toBe(false)
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
      }), bar, defaultKeymap)
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
  it('leaves a line the reader starts with a slash as plain answer text', () => {
      // An answer is text the model reads, so the menu the bar shows here carries
      // no commands: a slash neither narrows to a command nor completes into one,
      // and the text reaches the answer exactly as typed.
      const bar = answerBar()
      bar.setAutocompleteProvider(createAnswerCompletionProvider('/workspace', {
        candidates: async () => [{ path: 'src/ui/editor.ts', isDirectory: false }],
        reachable: async () => true,
      }))
      const gate = new QuestionGate(toGateQuestions({ questions: [{ id: 'q1', question: 'why?' }] }), bar, defaultKeymap)
      for (const character of '/compact') gate.handleKey(character)
      expect(bar.isShowingAutocomplete()).toBe(false)
      expect(answerText(gate)).toBe('/compact')
    })
  it('still answers the file menu an at-sign opens', async () => {
      // The menu is the base editor's own, so the gate never intercepts a press it
      // is drawing for: proof that borrowing the bar kept completion rather than
      // replacing it.
      const bar = answerBar()
      bar.setAutocompleteProvider(createAnswerCompletionProvider('/workspace', {
        candidates: async () => [{ path: 'src/ui/editor.ts', isDirectory: false }],
        reachable: async () => true,
      }))
      const gate = new QuestionGate(toGateQuestions({ questions: [{ id: 'q1', question: 'why?' }] }), bar, defaultKeymap)
      for (const character of '@edi') gate.handleKey(character)
      for (let attempt = 0; attempt < 200 && !bar.isShowingAutocomplete(); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      expect(bar.isShowingAutocomplete()).toBe(true)
    })
})
