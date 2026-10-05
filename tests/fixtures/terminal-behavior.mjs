/** Real widgets expose decoder and terminal-owner regressions without a model or profile credentials. */
import { performance } from 'node:perf_hooks'
import { ProcessTerminal, ScrollView, matchesKey } from '@earendil-works/pi-tui'
import { SOFTWARE_CURSOR_MODE } from '../../lib/terminal/cursor.js'
import { WarningSafeTui } from '../../lib/terminal/warning-screen.js'
import { TranscriptModel } from '../../lib/transcript.js'
import { contentLines } from '../../lib/cards.js'
import { cardOfResult } from '../../lib/cards/presenter.js'
import { DEFAULT_VIEW_STATE, TranscriptView } from '../../lib/ui/view.js'
import { DEFAULT_SPACING } from '../../lib/spacing.js'
import { toolDisplayTable } from '../../lib/tool-display.js'
import { MarkdownRenderer } from '../../lib/ui/markdown.js'
import { createMermaidTransform } from '../../lib/ui/mermaid.js'
import { BoxedEditor } from '../../lib/ui/editor.js'
import { PromptBar } from '../../lib/ui/prompt.js'
import { ListPicker } from '../../lib/ui/picker.js'
import { surfaceLayout } from '../../lib/ui/layout.js'
import { createTheme } from '../../lib/theme.js'
import { defaultKeymap } from '../../lib/input/actions.js'

// Native fixture rows use the same explicit layout and view ports as the mounted surface.
const FIXTURE_MERMAID_MODE = 'off'
const FIXTURE_MARGIN_COLUMNS = 0
const FIXTURE_TOOL_DISPLAY = toolDisplayTable().default
const READY = 'terminal-behavior-ready'
const RECEIPT = 'terminal-behavior-receipt:'
const QUIT_KEY = 'ctrl+c'
const CURSOR_MODE_ARG_INDEX = 2
const CURSOR_MODE = process.argv[CURSOR_MODE_ARG_INDEX] ?? SOFTWARE_CURSOR_MODE
const PICKER_KEY = 'ctrl+p'
const BORROW_KEY = 'ctrl+b'
const HANDOFF_KEY = 'ctrl+e'
const REPLACE_DRAFT_KEY = 'ctrl+d'
const CRASH_KEY = 'ctrl+g'
const CRASH_MESSAGE = 'terminal-behavior-forced-crash'
// The fixture owns an observation window longer than either software cursor phase.
const HANDOFF_MS = 1000
const SUSPENDED = 'terminal-behavior-suspended'
const RESUMED = 'terminal-behavior-resumed'
const SETTLED_MESSAGES = 100
const FOLD_LINE_COUNT = 150_000
const FOLD_DEPTH = 10_000
const FOLD_NESTED_TYPE = 'tool-result'
const FOLD_LINE = 'fold'
const FOLD_SEPARATOR = '\n'
const FOLD_PLUGIN = 'fold-proof'
const FOLD_EVENT = 'user/message'
const FOLD_SOURCE = 'plugin'
const TOOL_FOLD_NAME = 'fold-tool'
const TOOL_FOLD_ID = 'tool-fold-proof'
const TOOL_CALL_EVENT = 'tool/call'
const TOOL_RESULT_EVENT = 'tool/result'
const EMPTY_ARGUMENTS = '{}'
const FOLD_PREFIX = `injected ${FOLD_PLUGIN} · ${FOLD_LINE_COUNT} lines`
const LARGE_MESSAGE_CHARACTERS = 150_000
const LARGE_MESSAGE_TEXT = 'z'
const LARGE_MESSAGE_PREFIX = '- '
const STYLED_CHARACTERS = 8000
// Space stream updates to sustain redraw pressure without a tight loop; this cadence is not a latency budget.
const STREAM_INTERVAL_MS = 20
const STREAM_TEXT = '.'
const STYLED_TEXT = 'x'
const REPAINT_TEXT = 'y'
const CARRIAGE_RETURN = '\r'
const SGR_START = '\x1b[32m'
const SGR_END = '\x1b[0m'
// This gate checks input, geometry, and restoration, not palette output; omit theme-generated styling.
const COLOR_MODE = 'none'
const MESSAGE_EVENT = 'assistant/message'
const TEXT_CONTENT = 'text'
const TEXT_DELTA = 'text-delta'
// Match the mounted transcript's scroll policy so redraws exercise its production layout contract.
const SCROLL_POLICY = { follow: 'end', primary: true, overscroll: 'chain' }
const LATENCY_QUANTILE = 0.95
const PICKER_TITLE = 'Terminal input'
const PICKER_ROWS = [{ label: 'alpha' }, { label: '中😀' }]
const EXIT_SUCCESS = 0
const EXIT_FAILURE = 1

const terminal = new ProcessTerminal()
const tui = new WarningSafeTui(terminal, undefined, CURSOR_MODE)
const theme = createTheme(COLOR_MODE)
// Missing tool views must still preserve result counts through the production generic-card fallback.
const model = new TranscriptModel({
  call: () => undefined,
  result: (name, input) => cardOfResult(undefined, { name, failed: input.isError, contentLines: contentLines(input.content) }),
})
const pending = []
const latency = []
const failures = []
const renderedWidths = new Set()
let pickerOpen = false
let borrowed = false
let resumeTimer
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
// Deep recorded results must remain readable independently of their retained preview size.
let foldContent = [{ type: TEXT_CONTENT, text: Array(FOLD_LINE_COUNT).fill(FOLD_LINE).join(FOLD_SEPARATOR) }]
for (let depth = 0; depth < FOLD_DEPTH; depth++) foldContent = [{ type: FOLD_NESTED_TYPE, content: foldContent }]
// A summarized injection exercises the durable fold without letting rendering costs obscure ingestion failures.
model.apply({ type: FOLD_EVENT, data: { content: foldContent, source: { kind: FOLD_SOURCE, plugin: FOLD_PLUGIN } } })
const foldedNotice = model.entries().some(entry => entry.kind === 'notice' && entry.text.startsWith(FOLD_PREFIX))
// The card presenter must ingest the whole result before its normal retained-row budget takes effect.
model.apply({ type: TOOL_CALL_EVENT, data: { name: TOOL_FOLD_NAME, arguments: EMPTY_ARGUMENTS, callId: TOOL_FOLD_ID } })
model.apply({ type: TOOL_RESULT_EVENT, data: { message: { toolCallId: TOOL_FOLD_ID, content: foldContent, isError: false } } })
const toolFold = model.entries().find(entry => entry.kind === 'tool' && entry.id === TOOL_FOLD_ID)
// Settled assistant messages exercise redraws with conversation history, not only synthetic tool results.
// The count is a workload size, not an asserted retention threshold.
for (let index = 0; index < SETTLED_MESSAGES; index++) {
  model.apply({ type: MESSAGE_EVENT, data: { message: { content: [{ type: TEXT_CONTENT, text: `settled ${index}` }] } } })
}
// A retained message exercises the argument-safe row and copy paths when the driver narrows the terminal.
model.apply({ type: MESSAGE_EVENT, data: { message: { content: [{ type: TEXT_CONTENT, text: LARGE_MESSAGE_PREFIX + LARGE_MESSAGE_TEXT.repeat(LARGE_MESSAGE_CHARACTERS) }] } } })
// Long styled and carriage-return content must remain renderable through the driver's one-column resize.
// This is a wrapping workload, not a claim that the PTY displays the source escape sequences unchanged.
model.applyStreamChunk({ type: TEXT_DELTA, text: `${SGR_START}${STYLED_TEXT.repeat(STYLED_CHARACTERS)}${CARRIAGE_RETURN}${REPAINT_TEXT.repeat(STYLED_CHARACTERS)}${SGR_END}` })
const picker = new ListPicker(
  () => PICKER_ROWS, () => PICKER_TITLE, row => row.label,
  row => ({ label: row.label, description: undefined, current: false }), row => row.label,
  { empty: () => PICKER_TITLE, listed: () => PICKER_TITLE }, defaultKeymap,
)
const view = new TranscriptView(model, theme, new MarkdownRenderer(theme.markdown, createMermaidTransform({ theme, mode: () => FIXTURE_MERMAID_MODE })), {
  state: () => DEFAULT_VIEW_STATE,
  gate: () => undefined,
  picker: () => pickerOpen ? picker.card() : undefined,
  keys: defaultKeymap,
  toolDisplay: () => FIXTURE_TOOL_DISPLAY,
  spacing: () => DEFAULT_SPACING,
})
const editor = new BoxedEditor(tui, theme.editor, defaultKeymap, undefined, tui.cursor)
const empty = { render: () => [], invalidate: () => {} }
// Readiness belongs in frame output so the driver waits for native writes, not process startup.
// Width receipts record render calls; they do not independently prove that every frame reached the terminal.
const status = {
  render: width => {
    renderedWidths.add(width)
    return [READY]
  },
  invalidate: () => {},
}

/** A receipt survives outside the alternate screen so the driver can prove semantic retention and restoration. */
function finish() {
  if (ended) return
  ended = true
  clearInterval(stream)
  clearTimeout(resumeTimer)
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
    foldedNotice,
    foldLineCount: FOLD_LINE_COUNT,
    toolFoldLines: toolFold?.kind === 'tool' ? toolFold.card.totalLines : undefined,
    toolFoldRows: toolFold?.kind === 'tool' ? toolFold.card.detail.length : undefined,
    renderedWidths: [...renderedWidths],
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
// Picker bytes must not also edit the draft: the driver checks both decoders independently
// with Kitty events, Unicode, and paste, leaving ordinary input to the focused editor.
tui.addInputListener(data => {
  if (matchesKey(data, CRASH_KEY)) {
    // A real uncaught failure must restore the native tty before Node reports it.
    setImmediate(() => { throw new Error(CRASH_MESSAGE) })
    return { consume: true }
  }
  if (matchesKey(data, QUIT_KEY)) {
    finish()
    return { consume: true }
  }
  pending.push(performance.now())
  if (matchesKey(data, PICKER_KEY)) {
    pickerOpen = !pickerOpen
    tui.setFocus(pickerOpen ? null : editor)
    tui.requestImmediateRender()
    return { consume: true }
  }
  if (matchesKey(data, REPLACE_DRAFT_KEY)) {
    // Real global submission/history handlers replace drafts without calling editor.handleInput.
    editor.setText(editor.getExpandedText())
    tui.requestRender()
    return { consume: true }
  }
  if (matchesKey(data, BORROW_KEY)) {
    borrowed = !borrowed
    editor.disableSubmit = borrowed
    tui.setFocus(borrowed ? null : editor)
    if (borrowed) {
      // Questions deliberately borrow focus outside TUI's focused-component slot.
      editor.focused = true
      tui.cursor.setEditorFocused(true)
    }
    tui.requestImmediateRender()
    return { consume: true }
  }
  if (matchesKey(data, HANDOFF_KEY)) {
    clearInterval(stream)
    tui.stop({ preserveScreen: true })
    process.stdout.write(SUSPENDED + '\n')
    // Leave more than one caret phase for the driver to observe a silent borrowed terminal.
    resumeTimer = setTimeout(() => {
      process.stdout.write(RESUMED + '\n')
      tui.start()
      startStreaming()
    }, HANDOFF_MS)
    return { consume: true }
  }
  if (borrowed) {
    editor.handleInput(data)
    tui.requestRender()
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
}, () => FIXTURE_MARGIN_COLUMNS))
tui.setFocus(editor)
tui.start()
enteredRawMode = process.stdin.isRaw
/** Streaming pressure must return after a real stop/start handoff, without a second producer. */
function startStreaming() {
  stream = setInterval(() => {
    model.applyStreamChunk({ type: TEXT_DELTA, text: STREAM_TEXT })
    tui.requestRender()
  }, STREAM_INTERVAL_MS)
}
startStreaming()
