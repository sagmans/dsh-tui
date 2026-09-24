/**
 * What a gate suite needs to press keys at one: a stub terminal, a real answer
 * bar, a provider question list, and the bytes each key arrives as.
 */

import { type TUI } from '@earendil-works/pi-tui'
import { type GateQuestion } from '@/gates.ts'
import { QuestionGate, toGateQuestions } from '@/gates/questions.ts'
import { defaultKeymap, type Keymap } from '@/input/actions.ts'
import { createTheme } from '@/theme.ts'
import { GateInputBar } from '@/ui/gate-input.ts'

export /**
 * The terminal the bar renders against. Nothing in these tests reads the screen
 * size or repaints, so the bar under test is the real component over a stub.
 */
const STUB_TUI = { requestRender: () => {}, terminal: { rows: 24, cols: 80 } } as unknown as TUI
export /** The bar a gate collects its answers with, which the surface lends it. */
const answerBar = (): GateInputBar => new GateInputBar(STUB_TUI, createTheme('none').editor)
export /** A question gate over a fresh bar, which is how the surface builds one. */
const gateOver = (questions: readonly GateQuestion[], keys: () => Keymap = defaultKeymap): QuestionGate => new QuestionGate(questions, answerBar(), keys)
export /** What the bar holds, which is what an enter sends. */
const answerText = (gate: QuestionGate): string | undefined => gate.card().answerInput?.getExpandedText()
export /** What the bar draws, which is how the answer reaches the reader. */
const answerRows = (gate: QuestionGate): string => gate.card().answerInput?.render(60).join('\n') ?? ''
export const ESC = '\x1b'
export const ENTER = '\r'
export const UP = '\x1b[A'
export const LEFT = '\x1b[D'
export const DOWN = '\x1b[B'
export const BACKSPACE = '\x7f'
export /** The control byte a terminal sends for Ctrl+C, which is the surface cancel key. */
const CTRL_C = '\u0003'
export /** The control bytes a terminal sends for the navigation aliases of ↑ and ↓. */
const CTRL_P = '\u0010'
export const CTRL_N = '\u000e'
export /** A picker's question: several providers, two of them sharing a name. */
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
