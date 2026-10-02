/**
 * The free-text row and its paste path: what a declared credential hides, what
 * row 0 answers with, and how an editor keeps its plain mode across questions.
 */

import { describe, expect, it } from 'vitest'
import { CURSOR_MARKER } from '@earendil-works/pi-tui'
import { type Context } from '@deepseek-ai/cordis'
import { type GateQuestion } from '@/gates.ts'
import { QuestionGate, toGateQuestions } from '@/gates/questions.ts'
import { defaultKeymap, resolveKeymap } from '@/input/actions.ts'
import { createAnswerCompletionProvider } from '@/input/completion.ts'
import { createPromptInput, type PromptInputPorts } from '@/surface/prompt-input.ts'
import { PromptBar } from '@/ui/prompt.ts'
import { answerBar, gateOver, answerText, answerRows, ESC, ENTER, UP, LEFT, DOWN, CTRL_P, providerGate } from './fixtures/gate.ts'

/** A bracketed paste as the terminal sends it. */
const paste = (text: string): string => `\x1b[200~${text}\x1b[201~`
/** The native renderer needs the marker even when credential text is masked. */
const CURSOR = CURSOR_MARKER
const C1_START = 0x80
const C1_COUNT = 0x20
const C1_TEXT = Array.from({ length: C1_COUNT }, (_, index) => String.fromCharCode(C1_START + index)).join('')
const PROVIDER_FILTER_PASTES = ['Claude Pro', `Claude${C1_TEXT} Pro`]


describe('QuestionGate paste', () => {
  it('takes a pasted key as the whole answer instead of dropping it', () => {
      const gate = gateOver(toGateQuestions({ questions: [{ id: 'q1', question: 'key?' }] }))
      expect(gate.handleKey(paste('sk-ant-api03-abcDEF123\r\n'))).toBeUndefined()
      // The paste brings its own trailing newline; it is the answer's edge, not
      // its content, so the bar holds it and confirm trims it.
      expect(answerText(gate)?.trim()).toBe('sk-ant-api03-abcDEF123')
      expect(gate.handleKey(ENTER)).toEqual([{ id: 'q1', selected: [], custom: 'sk-ant-api03-abcDEF123' }])
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
  it.each(PROVIDER_FILTER_PASTES)('filters pasted provider names without admitting terminal controls: %j', (text) => {
      const gate = providerGate()
      gate.handleKey(paste(text))
      expect(gate.card().options.map(option => option.label)).toEqual(['Anthropic (Claude Pro/Max)'])
    })
  it('leads with the heading the caller sent, which the seam promises and a plugin relies on', () => {
      const gate = gateOver(toGateQuestions({ questions: [{ id: 'q1', question: 'why?', header: 'Sign in' }] }))
      expect(gate.card().title).toBe('Sign in · why?')
    })
})

/**
 * What a declared credential hides in the row the reader types into.
 *
 * Every case drives the gate the surface builds, because the declaration is the
 * question id's: the bar's mode is the gate's own answer to it, never something
 * a caller sets by hand.
 */
describe('the row a declared credential is drawn in', () => {
  const declared = (): QuestionGate => gateOver(toGateQuestions({ questions: [{ id: 'prompt:secret', question: 'Enter the value' }] }))
  const plain = (): QuestionGate => gateOver(toGateQuestions({ questions: [{ id: 'q1', question: 'Enter the value' }] }))

  it('shows an answer no question declared a credential, even when its wording says key', () => {
      // Wording is not a declaration: a question that merely mentions a key would
      // otherwise hide an answer its author meant the reader to check.
      const gate = gateOver(toGateQuestions({ questions: [{ id: 'q1', question: 'Enter the Anthropic API key' }] }))
      gate.handleKey(paste('sk-ant-api03-FAKE998877665544332211'))
      expect(answerText(gate)).toBe('sk-ant-api03-FAKE998877665544332211')
      expect(answerRows(gate)).toContain('FAKE9988')
    })
  it('hides everything between the first and last readable character', () => {
      const gate = declared()
      gate.handleKey(paste('sk-ant-api03-FAKE998877665544332211'))
      // The mask is a drawing, not the answer: what confirm sends is the text.
      expect(answerText(gate)).toBe('sk-ant-api03-FAKE998877665544332211')
      expect(answerRows(gate)).toContain('sk-a***************************2211')
    })
  it('shows a credential both readable ends cover rather than masking it whole', () => {
      const short = declared()
      const shown = plain()
      short.handleKey(paste('abcd1234'))
      shown.handleKey(paste('abcd1234'))
      // Every character is an end at this length; hiding the middle would hide
      // the whole answer and leave the reader checking a row of asterisks.
      expect(answerRows(short)).toBe(answerRows(shown))
      const longer = declared()
      longer.handleKey(paste('abcd12345'))
      expect(answerRows(longer)).toContain('abcd*2345')
    })
  it('masks a wide character by the columns it takes, so the row does not reflow', () => {
      const gate = declared()
      gate.handleKey(paste('head密钥密钥tail'))
      // Four wide characters take eight columns: one asterisk each would shorten
      // the row and move the text under the cursor.
      expect(answerRows(gate)).toContain('head********tail')
    })
  it('leaves the spacing of a credential alone while hiding its characters', () => {
      const gate = declared()
      gate.handleKey(paste('abcd efgh ijkl mnop'))
      // Whitespace is the editor's own layout, not part of the secret: masking
      // it would move the text under the cursor instead of hiding a character.
      expect(answerRows(gate)).toContain('abcd **** **** mnop')
    })
  it('keeps the cursor mark the terminal reads, which masking must not hide', () => {
      const bar = answerBar()
      const gate = new QuestionGate(toGateQuestions({ questions: [{ id: 'prompt:secret', question: 'Enter the value' }] }), bar, defaultKeymap)
      gate.handleKey(paste('sk-ant-api03-FAKE998877665544332211'))
      // The modal owner lends focus to the answer editor, not to the question gate.
      bar.focused = true
      const row = answerRows(gate)
      // Masking must preserve the native marker without revealing the credential.
      expect(row).toContain(CURSOR)
      expect(row.indexOf(CURSOR)).toBeGreaterThan(row.indexOf('2211'))
    })
})

describe('QuestionGate free-text row', () => {
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
      for (const character of 'ship 2 it') gate.handleKey(character)
      expect(gate.card().options.map(option => option.label)).toEqual(['yes', 'no'])
      expect(answerText(gate)).toBe('ship 2 it')
      expect(gate.handleKey(ENTER)).toEqual([{ id: 'q1', selected: [], custom: 'ship 2 it' }])
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
      gate.handleKey(DOWN)
      gate.handleKey(DOWN)
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
      // The hint is what tells the reader a paste lands in a bar they cannot see
      // an option list for, so a question with only text must still name it.
      expect(gate.card().hint).toContain('paste')
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
  it('leaves a line the reader starts with a slash as plain answer text', async () => {
      // An answer is text the model reads, so the menu has to follow the borrow
      // the surface takes: a slash neither narrows to a command nor completes
      // into one while a question is answered. The bar is borrowed by the
      // surface's own owner, because a test that installs the provider itself
      // stays green while a borrowed bar keeps the prompt's command menu.
      const editor = answerBar()
      const bar = new PromptBar(editor)
      const input = createPromptInput({} as unknown as Context, {
        editor: () => editor,
        promptBar: () => bar,
        drivenAgent: () => ({}),
        registeredCommands: () => [{ name: 'compact', description: 'compact' }],
      } as unknown as PromptInputPorts)
      input.installCompletion()
      // The bar answers its completion request off the input path, so both halves
      // wait the same budget: the menu the last half reads proves the wait long
      // enough for the absence the first half asserts.
      const settle = async (): Promise<void> => {
        for (let attempt = 0; attempt < 20; attempt++) await new Promise(resolve => setTimeout(resolve, 5))
      }
      const gate = bar.borrow(() => {
        const opened = new QuestionGate(toGateQuestions({ questions: [{ id: 'q1', question: 'why?' }] }), editor, defaultKeymap)
        input.applyCompletion()
        return opened
      })
      for (const character of '/compact') gate.handleKey(character)
      await settle()
      expect(editor.isShowingAutocomplete()).toBe(false)
      expect(editor.getExpandedText()).toBe('/compact')
      bar.giveBack()
      input.applyCompletion()
      for (const character of '/compact') editor.handleInput(character)
      await settle()
      expect(editor.isShowingAutocomplete()).toBe(true)
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
      // The row is the workspace's own listing, which is what makes this the
      // answer's file menu rather than a menu that merely exists.
      expect(bar.render(60).some(line => line.includes('editor.ts'))).toBe(true)
    })
})
