/**
 * The transcript view every rendering suite builds on: a plain theme, a
 * presenter that answers for one tool, the states the cases flip, and the
 * event helpers they fold into a model.
 */

import { it } from 'vitest'
import { type TUI, type TuiMouseEvent } from '@earendil-works/pi-tui'
import { cardOfCall, cardOfResult } from '@/cards/presenter.ts'
import { contentLines, type ToolPresenter } from '@/cards.ts'
import { type GateCard } from '@/gates.ts'
import { createTheme } from '@/theme.ts'
import { TranscriptModel } from '@/transcript.ts'
import { MarkdownRenderer } from '@/ui/markdown.ts'
import { BoxedEditor } from '@/ui/editor.ts'
import { TranscriptView, type ViewState } from '@/ui/view.ts'
import { toolDisplayFor, type ToolDisplayTable } from '@/tool-display.ts'

export const theme = createTheme('none')
export /** The terminal the bar under test renders against; these tests read its rows only. */
const STUB_TUI = { requestRender: () => {}, terminal: { rows: 24, cols: 80 } } as unknown as TUI
export /** How the real bash tool declares itself: a terminal card whose title is the command. */
const bashPresenter: ToolPresenter = {
  call: (name, argumentsJson) => cardOfCall(
    { card: 'terminal', title: (JSON.parse(argumentsJson) as { command?: string }).command ?? '' },
    name,
  ),
  result: (name, input) => cardOfResult(
    { card: 'terminal', output: contentLines(input.content).join('\n'), exitCode: input.isError ? 1 : 0 },
    { name, failed: input.isError, contentLines: contentLines(input.content) },
  ),
}
export /** The editor a gate answers in, which is the surface's own prompt bar. */
const answerBar = (text: string): BoxedEditor => {
  const bar = new BoxedEditor(STUB_TUI, theme.editor)
  bar.setText(text)
  return bar
}
export /** The 24-bit foreground a palette entry is painted with, as a rendered row carries it. */
const painted = (hex: string): string =>
  `38;2;${[1, 3, 5].map(at => Number.parseInt(hex.slice(at, at + 2), 16)).join(';')}`
export const COLLAPSED: ViewState = { expandCards: false, expandReasoning: false, expandSubCalls: false }
export /** Every card opened, which is the shape a wrapping assertion needs to see. */
const OPEN: ViewState = { expandCards: true, expandReasoning: false, expandSubCalls: false }
export function viewOf(
  model: TranscriptModel,
  state: ViewState = COLLAPSED,
  gate?: GateCard,
  tools?: ToolDisplayTable,
): TranscriptView {
  return new TranscriptView(model, theme, new MarkdownRenderer(theme.markdown), {
    state: () => state,
    gate: () => gate,
    ...(tools === undefined ? {} : { toolDisplay: tool => toolDisplayFor(tools, tool) }),
  })
}
export const toolCall = (argumentsJson = '{}') => ({ type: 'tool/call', data: { name: 'bash', arguments: argumentsJson, callId: 'c1' } })
export const toolResult = (text: string) => ({
  type: 'tool/result',
  data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', text }], isError: false } },
})
export /** One mouse event on the row at `y`, with the fields the surface fills in. */
const mouse = (type: TuiMouseEvent['type'], button: TuiMouseEvent['button'], y: number): TuiMouseEvent => ({
  type,
  button,
  x: 0,
  y,
  screenX: 0,
  screenY: y,
  width: 60,
  height: 24,
  shift: false,
  alt: false,
  ctrl: false,
})
