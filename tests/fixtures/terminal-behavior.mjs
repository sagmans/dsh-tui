/** Real widgets expose decoder and terminal-owner regressions without a model or profile credentials. */
import { performance } from 'node:perf_hooks'
import { ProcessTerminal, ScrollView, matchesKey } from '@earendil-works/pi-tui'
import { WarningSafeTui } from '../../lib/terminal/warning-screen.js'
import { TranscriptModel } from '../../lib/transcript.js'
import { TranscriptView } from '../../lib/ui/view.js'
import { MarkdownRenderer } from '../../lib/ui/markdown.js'
import { BoxedEditor } from '../../lib/ui/editor.js'
import { PromptBar } from '../../lib/ui/prompt.js'
import { ListPicker } from '../../lib/ui/picker.js'
import { surfaceLayout } from '../../lib/ui/layout.js'
import { createTheme } from '../../lib/theme.js'
import { defaultKeymap } from '../../lib/input/actions.js'

const READY = 'terminal-behavior-ready'
const RECEIPT = 'terminal-behavior-receipt:'
const QUIT_KEY = 'ctrl+c'
const PICKER_KEY = 'ctrl+p'
const SETTLED_MESSAGES = 100
const LARGE_MESSAGE_CHARACTERS = 150_000
const LARGE_MESSAGE_TEXT = 'z'
const STYLED_CHARACTERS = 8000
const STREAM_INTERVAL_MS = 20
const STREAM_TEXT = '.'
const STYLED_TEXT = 'x'
const REPAINT_TEXT = 'y'
const CARRIAGE_RETURN = '\r'
const SGR_START = '\x1b[32m'
const SGR_END = '\x1b[0m'
const COLOR_MODE = 'none'
const MESSAGE_EVENT = 'assistant/message'
const TEXT_CONTENT = 'text'
const TEXT_DELTA = 'text-delta'
const SCROLL_POLICY = { follow: 'end', primary: true, overscroll: 'chain' }
const LATENCY_QUANTILE = 0.95
const PICKER_TITLE = 'Terminal input'
const PICKER_ROWS = [{ label: 'alpha' }, { label: '中😀' }]
const EXIT_SUCCESS = 0
const EXIT_FAILURE = 1

const terminal = new ProcessTerminal()
const tui = new WarningSafeTui(terminal)
const theme = createTheme(COLOR_MODE)
const model = new TranscriptModel()
const pending = []
const latency = []
const failures = []
let pickerOpen = false
let ended = false
let enteredRawMode = false
let stream
const write = terminal.write.bind(terminal)
// Native writes, not a render request or an AX value, establish the measured boundary.
terminal.write = data => {
  write(data)
  const now = performance.now()
  for (const start of pending.splice(0)) latency.push(now - start)
}
for (let index = 0; index < SETTLED_MESSAGES; index++) {
  model.apply({ type: MESSAGE_EVENT, data: { message: { content: [{ type: TEXT_CONTENT, text: `settled ${index}` }] } } })
}
// A retained message exercises the argument-safe row and copy paths when the driver narrows the terminal.
model.apply({ type: MESSAGE_EVENT, data: { message: { content: [{ type: TEXT_CONTENT, text: LARGE_MESSAGE_TEXT.repeat(LARGE_MESSAGE_CHARACTERS) }] } } })
model.applyStreamChunk({ type: TEXT_DELTA, text: `${SGR_START}${STYLED_TEXT.repeat(STYLED_CHARACTERS)}${CARRIAGE_RETURN}${REPAINT_TEXT.repeat(STYLED_CHARACTERS)}${SGR_END}` })
const picker = new ListPicker(
  () => PICKER_ROWS, () => PICKER_TITLE, row => row.label,
  row => ({ label: row.label, description: undefined, current: false }), row => row.label,
  { empty: () => PICKER_TITLE, listed: () => PICKER_TITLE }, defaultKeymap,
)
const view = new TranscriptView(model, theme, new MarkdownRenderer(theme.markdown), {
  picker: () => pickerOpen ? picker.card() : undefined,
})
const editor = new BoxedEditor(tui, theme.editor)
const empty = { render: () => [], invalidate: () => {} }
const status = { render: () => [READY], invalidate: () => {} }

/** A receipt survives outside the alternate screen so the driver can prove semantic retention and restoration. */
function finish() {
  if (ended) return
  ended = true
  clearInterval(stream)
  tui.stop({ preserveScreen: true })
  const sorted = latency.toSorted((left, right) => left - right)
  const receipt = {
    draft: editor.getText(),
    filter: picker.card().filter,
    rawMode: process.stdin.isRaw,
    enteredRawMode,
    failures,
    settledMessages: SETTLED_MESSAGES,
    styledCharacters: STYLED_CHARACTERS,
    largeMessageCharacters: LARGE_MESSAGE_CHARACTERS,
    outputSamples: sorted.length,
    dispatchToWriteP95Ms: sorted[Math.floor(sorted.length * LATENCY_QUANTILE)] ?? null,
  }
  process.stdout.write(`\n${RECEIPT}${JSON.stringify(receipt)}\n`, () => {
    process.exit(failures.length === 0 ? EXIT_SUCCESS : EXIT_FAILURE)
  })
}
tui.onFrameError = error => {
  failures.push(error instanceof Error ? error.stack ?? String(error) : String(error))
  finish()
}
tui.addInputListener(data => {
  if (matchesKey(data, QUIT_KEY)) {
    finish()
    return { consume: true }
  }
  pending.push(performance.now())
  if (matchesKey(data, PICKER_KEY)) {
    pickerOpen = !pickerOpen
    tui.requestImmediateRender()
    return { consume: true }
  }
  if (pickerOpen) {
    picker.handleKey(data)
    tui.requestImmediateRender()
    return { consume: true }
  }
  return undefined
})
tui.setLayoutRoot(surfaceLayout({
  transcript: new ScrollView(view, SCROLL_POLICY),
  dock: empty, queue: empty, prompt: new PromptBar(editor), status,
}))
tui.setFocus(editor)
tui.start()
enteredRawMode = process.stdin.isRaw
stream = setInterval(() => {
  model.applyStreamChunk({ type: TEXT_DELTA, text: STREAM_TEXT })
  tui.requestRender()
}, STREAM_INTERVAL_MS)
