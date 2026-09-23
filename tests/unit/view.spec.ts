import { describe, expect, it } from 'vitest'
import { stripTerminalSequences, type TUI, type TuiMouseEvent, visibleWidth } from '@earendil-works/pi-tui'
import { cardOfCall, cardOfResult, contentLines, CARD_DETAIL_MAX, CARD_SHELL_PREVIEW, SUBCALL_MAX, type ToolPresenter } from '@/cards.ts'
import type { GateCard } from '@/gates.ts'
import { createTheme, forwardEditorTheme, forwardMarkdownTheme, type TuiTheme } from '@/theme.ts'
import { DEFAULT_PALETTE, DIFF_ADDED_BAND } from '@/theme-tokens.ts'
import { SECOND_MS, TranscriptModel, type TranscriptEntry } from '@/transcript.ts'
import { cleanCopied } from '@/ui/copy.ts'
import { MarkdownRenderer } from '@/ui/markdown.ts'
import type { PickerCard } from '@/ui/picker.ts'
import { RowCache } from '@/ui/rows.ts'
import { BoxedEditor } from '@/ui/editor.ts'
import { TranscriptView, type ViewState } from '@/ui/view.ts'
import { DEFAULT_TOOL_DISPLAY, toolDisplayFor, toolDisplayTable, type ToolDisplayTable } from '@/tool-display.ts'

const theme = createTheme('none')

/** The terminal the bar under test renders against; these tests read its rows only. */
const STUB_TUI = { requestRender: () => {}, terminal: { rows: 24, cols: 80 } } as unknown as TUI

/** How the real bash tool declares itself: a terminal card whose title is the command. */
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

/** The editor a gate answers in, which is the surface's own prompt bar. */
const answerBar = (text: string): BoxedEditor => {
  const bar = new BoxedEditor(STUB_TUI, theme.editor)
  bar.setText(text)
  return bar
}
/** The 24-bit foreground a palette entry is painted with, as a rendered row carries it. */
const painted = (hex: string): string =>
  `38;2;${[1, 3, 5].map(at => Number.parseInt(hex.slice(at, at + 2), 16)).join(';')}`

const COLLAPSED: ViewState = { expandCards: false, expandReasoning: false, expandSubCalls: false }
/** Every card opened, which is the shape a wrapping assertion needs to see. */
const OPEN: ViewState = { expandCards: true, expandReasoning: false, expandSubCalls: false }

function viewOf(
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

const toolCall = (argumentsJson = '{}') => ({ type: 'tool/call', data: { name: 'bash', arguments: argumentsJson, callId: 'c1' } })
const toolResult = (text: string) => ({
  type: 'tool/result',
  data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', text }], isError: false } },
})

/** One mouse event on the row at `y`, with the fields the surface fills in. */
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

describe('TranscriptView repaints', () => {
  it('reuses the rows it already built instead of re-wrapping the transcript', () => {
    const rows = new RowCache<TranscriptEntry>()
    const model = new TranscriptModel()
    model.apply({ type: 'user/message', data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } })
    model.apply({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'hi' }] } } })
    const view = new TranscriptView(model, theme, new MarkdownRenderer(theme.markdown), { rows })

    const first = view.render(80)
    expect(rows.stats()).toEqual({ hits: 0, misses: 2 })
    expect(view.render(80)).toEqual(first)
    expect(rows.stats()).toEqual({ hits: 2, misses: 2 })
  })

  it('rebuilds when a resize or an expansion changes what the rows say', () => {
    const rows = new RowCache<TranscriptEntry>()
    const model = new TranscriptModel()
    model.apply({ type: 'user/message', data: { content: [{ type: 'text', text: 'hello there' }], source: { kind: 'user' } } })
    const state = { expandCards: false, expandReasoning: false, expandSubCalls: false }
    const view = new TranscriptView(model, theme, new MarkdownRenderer(theme.markdown), { rows, state: () => state })

    view.render(80)
    expect(rows.stats().misses).toBe(1)
    view.render(40)
    expect(rows.stats().misses).toBe(2)
    state.expandCards = true
    view.render(40)
    expect(rows.stats().misses).toBe(3)
    // The nested-call flag is part of the tag too, or a toggle would reuse the
    // rows drawn before the calls were meant to be on screen.
    state.expandSubCalls = true
    view.render(40)
    expect(rows.stats().misses).toBe(4)
  })

  it('rebuilds a running row as its duration moves and never a settled one', () => {
    const rows = new RowCache<TranscriptEntry>()
    const clockState = { now: 1_000 }
    const model = new TranscriptModel(bashPresenter, () => clockState.now)
    model.apply({ type: 'tool/call', data: { name: 'bash', arguments: '{"command":"pnpm test"}', callId: 'c1' } })
    const view = new TranscriptView(model, theme, new MarkdownRenderer(theme.markdown), { rows })

    expect(view.render(60)).toEqual(['bash pnpm test'])
    // Within the same second the row cannot have changed, so the frame reuses it.
    expect(view.render(60)).toEqual(['bash pnpm test'])
    expect(rows.stats()).toEqual({ hits: 1, misses: 1 })

    clockState.now += SECOND_MS
    expect(view.render(60)).toEqual(['bash pnpm test · ~1s'])
    expect(rows.stats()).toEqual({ hits: 1, misses: 2 })

    model.apply({
      type: 'tool/result',
      data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', text: 'all green' }], isError: false } },
    })
    expect(view.render(60)).toEqual(['bash pnpm test · exit 0 · 1 line'])
    clockState.now += 30 * SECOND_MS
    // A call that came back stops being redrawn: the row it settled into is the
    // one the cache keeps, and nothing on it is measured by the clock any more.
    expect(view.render(60)).toEqual(['bash pnpm test · exit 0 · 1 line'])
    expect(rows.stats()).toEqual({ hits: 2, misses: 3 })
  })
})

describe('TranscriptView text', () => {
  it('renders assistant text as markdown inside its frame', () => {
    const model = new TranscriptModel()
    model.apply({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '# Title\n\nplain **strong**' }] } } })
    const lines = viewOf(model).render(60)
    expect(lines[0]?.startsWith('╭')).toBe(true)
    expect(lines.at(-1)?.startsWith('╰')).toBe(true)
    const body = stripTerminalSequences(lines.join('\n'))
    expect(body).toContain('Title')
    expect(body).toContain('strong')
    expect(body).not.toContain('**')
  })

  it("renders a submitted prompt's markdown inside its frame", () => {
    const model = new TranscriptModel()
    model.apply({
      type: 'user/message',
      data: { content: [{ type: 'text', text: '**bold** steps:\n\n- one\n- two' }], source: { kind: 'user' } },
    })
    const lines = viewOf(model).render(40)
    expect(lines[0]?.startsWith('╭')).toBe(true)
    expect(lines.at(-1)?.startsWith('╰')).toBe(true)
    const body = stripTerminalSequences(lines.join('\n'))
    expect(body).toContain('bold steps:')
    expect(body).not.toContain('**')
    expect(body).toContain('- one')
    expect(body).toContain('- two')
  })

  it("closes a human prompt into the editor's own frame", () => {
    const model = new TranscriptModel()
    model.apply({ type: 'user/message', data: { content: [{ type: 'text', text: 'hello there' }], source: { kind: 'user' } } })
    // The box the editor and the queued prompts draw, so a submitted prompt reads
    // as the object it was typed into rather than as one more paragraph.
    expect(viewOf(model).render(40)).toEqual([
      `╭${'─'.repeat(38)}╮`,
      `│ hello there${' '.repeat(25)} │`,
      `╰${'─'.repeat(38)}╯`,
    ])
  })

  it('closes a reply into a frame of its own', () => {
    const model = new TranscriptModel()
    model.apply({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'hello there' }] } } })
    // A reply is the other object of an exchange, so it is framed like the prompt
    // that asked for it rather than left as one more paragraph of the transcript.
    expect(viewOf(model).render(40)).toEqual([
      `╭${'─'.repeat(38)}╮`,
      `│ hello there${' '.repeat(25)} │`,
      `╰${'─'.repeat(38)}╯`,
    ])
  })

  it('leaves a surface notice outside the frame', () => {
    const model = new TranscriptModel()
    model.notice('compacted 12 events')
    expect(viewOf(model).render(40)).toEqual(['compacted 12 events'])
  })

  it('draws a title the way the terminal that wrote it would have', () => {
    // Any sequence the presenter hands over is read here: what a terminal would
    // act on cannot reach the row, and what is really text still can.
    const model = new TranscriptModel({
      call: () => ({ kind: 'generic', tool: 'bash', title: '\u001b[31mred\u0007', detail: [], failed: false, totalLines: 0 }),
      result: () => undefined,
    })
    model.apply(toolCall())
    model.apply(toolResult('plain'))
    const rendered = viewOf(model).render(60).join('\n')
    // These rows run with colour off, so the colour sequence is consumed rather
    // than shown; a bell is not a sequence, so it is spelled, not swallowed.
    expect(rendered).toContain('red\\x07')
    expect(rendered).not.toContain('\u001b')
  })

  it('keeps a tool colour the terminal can draw, and still spells a stray control', () => {
    const colour = createTheme('truecolor')
    const model = new TranscriptModel({
      call: () => ({ kind: 'generic', tool: 'bash', title: '\u001b[31mred\u001b[0mplain\u0007', detail: [], failed: false, totalLines: 0 }),
      result: () => undefined,
    })
    model.apply(toolCall())
    model.apply(toolResult('plain'))
    const view = new TranscriptView(model, colour, new MarkdownRenderer(colour.markdown), { state: () => COLLAPSED })
    const rendered = view.render(60).join('\n')
    expect(rendered).toContain('\u001b[38;5;1mred')
    expect(rendered).toContain('plain\\x07')
  })

  it('renders a recorded thought, folded or open, dimmed, and frames the answer', () => {
    const model = new TranscriptModel()
    model.apply({
      type: 'assistant/message',
      data: {
        message: {
          content: [
            { type: 'reasoning', text: 'first thought\nsecond thought' },
            { type: 'text', text: 'the answer' },
          ],
        },
      },
    })
    const colour = createTheme('truecolor')
    const markdown = new MarkdownRenderer(colour.markdown)
    const folded = new TranscriptView(model, colour, markdown, { state: () => ({ expandCards: false, expandReasoning: false, expandSubCalls: false }) }).render(60)
    expect(folded).toEqual(expect.arrayContaining([expect.stringContaining('reasoning · 7 tokens')]))
    // The signpost is its own faint shade, italic, not the muted grey the body
    // takes: the row names the thought, it is not the thought.
    expect(folded[0]).toContain('\u001b[3;38;2;102;102;102m')
    expect(folded[0]).not.toContain('\u001b[38;2;138;138;138m')
    expect(folded.some(line => line.includes('second thought'))).toBe(false)

    const opened = new TranscriptView(model, colour, markdown, { state: () => ({ expandCards: false, expandReasoning: true, expandSubCalls: false }) }).render(60)
    // The signpost, the two thought rows, and the framed answer: a reply is an
    // object of its own rather than one more row under the thought.
    expect(opened).toHaveLength(6)
    expect(opened[0]).toContain('\u001b[3;38;2;102;102;102m')
    // The thought shares the signpost's faint shade, not the muted family's.
    for (const line of opened.slice(1, 3)) expect(line).toContain('\u001b[38;2;102;102;102m')
    // The frame's own rows carry the border's shade, so the corners are found in
    // the row rather than at its start.
    expect(opened[3]).toContain('╭')
    expect(stripTerminalSequences(opened[4] ?? '')).toContain('the answer')
    expect(opened[5]).toContain('╰')
  })

  it('renders an opened thought as markdown in the thought shade', () => {
    const colour = createTheme('truecolor')
    const model = new TranscriptModel()
    model.apply({
      type: 'assistant/message',
      data: { message: { content: [{ type: 'reasoning', text: '**bold** plan\n\n- one' }, { type: 'text', text: 'the answer' }] } },
    })
    const opened = new TranscriptView(model, colour, new MarkdownRenderer(colour.markdown), {
      state: () => ({ expandCards: false, expandReasoning: true, expandSubCalls: false }),
    }).render(60)
    const body = stripTerminalSequences(opened.join('\n'))
    expect(body).toContain('bold plan')
    expect(body).not.toContain('**')
    expect(body).toContain('- one')
    // The structure is markdown's, the shade is still the thought's: the
    // answer's accent must not leak into a row meant to stay recessive. A blank
    // row holds no text and so has no shade to check, and the signpost row above
    // the body carries its own fainter one.
    expect(opened[0]).toContain('\u001b[3;38;2;102;102;102m')
    // The thought body ends where the answer's frame begins, and that frame is
    // gold rather than faint: the loop stops at the box so the reply's own border
    // is not read as a thought row that lost its shade.
    const framed = opened.findIndex(line => line.includes('╭'))
    expect(framed).toBeGreaterThan(0)
    for (const line of opened.slice(1, framed).filter(line => line !== '')) {
      expect(line).toContain('\u001b[38;2;102;102;102m')
    }
    expect(stripTerminalSequences(opened.slice(framed).join('\n'))).toContain('the answer')
  })

  it('keeps a thought fence as source while the answer still draws it', () => {
    const fence = '**note**\n\n```mermaid\nflowchart TB\n  A --> B\n```'
    let rendered = 0
    const markdown = new MarkdownRenderer(theme.markdown, () => {
      rendered += 1
      return 'DIAGRAM'
    })
    const model = new TranscriptModel()
    model.apply({
      type: 'assistant/message',
      data: { message: { content: [{ type: 'reasoning', text: fence }, { type: 'text', text: fence }] } },
    })
    const lines = new TranscriptView(model, theme, markdown, {
      state: () => ({ expandCards: false, expandReasoning: true, expandSubCalls: false }),
    }).render(60)
    const drawn = lines.join('\n')
    // One drawing for the answer, none for the thought: a thought parses its own
    // markdown but a diagram would give the thinking the answer's weight.
    expect(rendered).toBe(1)
    expect(drawn).toContain('DIAGRAM')
    expect(drawn).toContain('```mermaid')
    expect(stripTerminalSequences(drawn)).not.toContain('**')
  })

  it('wraps a long line to the width it was given', () => {
    const model = new TranscriptModel()
    model.apply({ type: 'user/message', data: { content: [{ type: 'text', text: 'x'.repeat(50) }], source: { kind: 'user' } } })
    const lines = viewOf(model).render(20)
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(20)
  })

  it('wraps a long prompt inside its frame instead of cutting it', () => {
    const model = new TranscriptModel()
    model.apply({ type: 'user/message', data: { content: [{ type: 'text', text: 'x'.repeat(50) }], source: { kind: 'user' } } })
    const lines = viewOf(model).render(40)
    expect(lines).toHaveLength(4)
    for (const line of lines) expect(visibleWidth(line)).toBe(40)
    expect(lines[0]?.startsWith('╭')).toBe(true)
    expect(lines[3]?.startsWith('╰')).toBe(true)
    // Every column of the prompt survives the fold: the frame costs the text
    // width, it never costs the reader a line.
    const body = lines.slice(1, 3).map(line => line.slice(2, -2).trimEnd()).join('')
    expect(body).toBe('x'.repeat(50))
  })
})

describe('TranscriptView markers', () => {
  it('sets a boundary row apart from what anyone said', () => {
    const model = new TranscriptModel()
    model.marker('compacted 12 events (≈3000 tokens)')
    expect(viewOf(model).render(60)).toEqual(['compacted 12 events (≈3000 tokens)'])
  })
})

describe('TranscriptView expansion', () => {
  /** A tool card of `rows` lines, from a tool that presents shell output only when asked. */
  const withRows = (rows: number, name = 'read'): TranscriptModel => {
    const lines = Array.from({ length: rows }, (_, index) => `row ${index}`)
    const presenter: ToolPresenter = {
      call: (toolName, argumentsJson) => cardOfCall(
        toolName === 'bash'
          ? { card: 'terminal', title: 'Run echo rows' }
          : { card: 'generic', title: `Read ${argumentsJson}` },
        toolName,
      ),
      result: (toolName, input) => cardOfResult(
        toolName === 'bash'
          ? { card: 'terminal', title: 'Run echo rows', output: contentLines(input.content).join('\n'), exitCode: 0 }
          : { card: 'generic', title: `Read ${name}` },
        { name: toolName, failed: input.isError, contentLines: contentLines(input.content) },
      ),
    }
    const model = new TranscriptModel(presenter)
    model.apply({ type: 'tool/call', data: { name, arguments: '{"path":"a.ts"}', callId: 'c1' } })
    model.apply({
      type: 'tool/result',
      data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', text: lines.join('\n') }], isError: false } },
    })
    return model
  }

  it('folds a tool card to its title and says nothing about a body it can still open', () => {
    // One line, and not even a hint: a card that keeps no row has nothing to
    // count, so the fold is silent about a body ctrl+o can still open.
    expect(viewOf(withRows(25)).render(60)).toEqual(['Read {"path":"a.ts"}'])
  })

  it('shows every row once a folded card is opened with ctrl+o', () => {
    const lines = viewOf(withRows(25), { expandCards: true, expandReasoning: false, expandSubCalls: false }).render(60)
    expect(lines.filter(line => line.startsWith('    row '))).toHaveLength(25)
    expect(lines.some(line => line.includes('ctrl+o'))).toBe(false)
  })

  it('folds a shell run to one row that keeps its command, outcome, and hidden rows', () => {
    const lines = viewOf(withRows(25, 'bash')).render(60)
    // One row is the whole contract of the fold; the facts a reader needs without
    // opening it — what ran, how it ended, how much sits behind it — ride that row.
    expect(lines).toEqual(['bash Run echo rows · exit 0 · 25 lines'])
  })

  it('shows a shell card whole once it is opened, and a short one without a hint', () => {
    const opened = viewOf(withRows(25, 'bash'), OPEN).render(60)
    expect(opened[0]).toBe('bash')
    expect(opened[1]).toBe('    Run echo rows')
    expect(opened.filter(line => line.startsWith('    row '))).toHaveLength(25)
    expect(opened.some(line => line.includes('earlier lines'))).toBe(false)
    const short = viewOf(withRows(3, 'bash'), OPEN).render(60)
    expect(short.filter(line => line.startsWith('    row '))).toHaveLength(3)
    // The label, the command, three output rows, and the exit status.
    expect(short).toHaveLength(6)
    expect(short.at(-1)).toBe('    exit 0')
    // Folded, the output is behind the fold whatever its size, so the row says
    // how many lines are waiting there.
    expect(viewOf(withRows(3, 'bash')).render(60)).toEqual(['bash Run echo rows · exit 0 · 3 lines'])
  })

  it("names an opened shell card's dropped rows as the earlier ones", () => {
    // Retention keeps the tail, so opening a run past the cap reveals its end
    // and hides its beginning; a neutral count would point the reader past the
    // last row on screen for rows that are above it.
    const opened = viewOf(withRows(250, 'bash'), OPEN).render(60)
    expect(opened.filter(line => line.startsWith('    row '))).toHaveLength(CARD_DETAIL_MAX)
    expect(opened).toContain('    exit 0')
    expect(opened.at(-1)).toBe('    … 50 earlier lines not shown')
  })

  it("keeps a failed shell card's command, outcome, and title folded, and its output when opened", () => {
    // Built through the real card mappers so the assertion covers the shell
    // shape a failing command actually produces, not a hand-made card.
    const failing: ToolPresenter = {
      call: name => cardOfCall({ card: 'terminal', title: 'rm -rf /tmp/x' }, name),
      result: (name, input) => cardOfResult(
        { card: 'terminal', output: 'boom', exitCode: 1 },
        { name: name, failed: input.isError, contentLines: contentLines(input.content) },
      ),
    }
    const model = new TranscriptModel(failing)
    model.apply({ type: 'tool/call', data: { name: 'bash', arguments: '{}', callId: 'c1' } })
    model.apply({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', text: 'boom' }], isError: true } } })
    // Folded, the failure is still legible: the command, the exit code, and the
    // one row behind it; opening it shows what actually came back.
    expect(viewOf(model).render(60)).toEqual(['bash rm -rf /tmp/x · exit 1 · 1 line'])
    const opened = viewOf(model, OPEN).render(60)
    expect(opened).toContain('    boom')
    expect(opened).toContain('    exit 1')
  })

  it('opens one clicked thought and leaves the other folded', () => {
    const model = new TranscriptModel()
    model.apply({
      type: 'assistant/message',
      data: { message: { content: [
        { type: 'reasoning', text: 'first thought' },
        { type: 'reasoning', text: 'second thought' },
        { type: 'text', text: 'answer' },
      ] } },
    })
    const view = viewOf(model)
    const folded = view.render(60)
    expect(folded[0]).toMatch(/^reasoning · \d+ tokens \(shift\+tab\)$/)
    expect(folded[1]).toMatch(/^reasoning · \d+ tokens \(shift\+tab\)$/)
    // A click opens the thought it landed on; the one below stays folded.
    expect(view.handleMouse(mouse('click', 'left', 0))).toEqual({ handled: true, render: true })
    const opened = view.render(60)
    expect(opened[1]).toBe('    first thought')
    expect(opened.join('\n')).not.toContain('    second thought')
    expect(opened[2]).toMatch(/\(shift\+tab\)$/)
    // The choice survives the repaint, and a second click folds it back.
    expect(view.render(60)).toEqual(opened)
    view.handleMouse(mouse('click', 'left', 0))
    expect(view.render(60)).toEqual(folded)
  })

  it('opens a clicked thought while it is still streaming', () => {
    const model = new TranscriptModel()
    model.notice('before')
    model.applyStreamChunk({ type: 'reasoning-delta', text: 'live thought' })
    const view = viewOf(model)
    const rows = view.render(60)
    expect(rows[0]).toBe('before')
    expect(rows[1]).toMatch(/^reasoning · 3 tokens/)
    // The thought's rows begin after the notice, and the hit target has to move
    // with them: a span counted twice would sit past the thought's own row.
    expect(view.handleMouse(mouse('click', 'left', 1))).toEqual({ handled: true, render: true })
    expect(view.render(60)).toContain('    live thought')
  })

  it('shows the output a clicked shell card kept', () => {
    const view = viewOf(withRows(3, 'bash'))
    expect(view.render(60)).toEqual(['bash Run echo rows · exit 0 · 3 lines'])
    // A click opens the one card and reveals what the command printed.
    view.handleMouse(mouse('click', 'left', 0))
    const opened = view.render(60)
    expect(opened.filter(line => line.startsWith('    row '))).toHaveLength(3)
    expect(opened).toContain('    exit 0')
  })

  it('keeps a folded reasoning row inside a terminal too narrow for its key', () => {
    const model = new TranscriptModel()
    model.apply({ type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'thought' }, { type: 'text', text: 'answer' }] } } })
    const rows = viewOf(model).render(5)
    // The key cannot fit beside the signpost, so the row gives up its tail rather
    // than the surface losing it past the edge where nothing can count it.
    expect(rows.every(row => visibleWidth(row) <= 5)).toBe(true)
  })

  it('names where the thought is when the row is folded', () => {
    let clock = 0
    const model = new TranscriptModel(undefined, () => clock)
    model.applyStreamChunk({ type: 'reasoning-delta', text: 'first thought\nsecond thought' })
    clock = 5_000
    model.applyStreamChunk({ type: 'block-end', block: { type: 'reasoning' } })
    const folded = viewOf(model).render(60)
    // The row must say the body exists: a count with no way to reach the text
    // reads the same as the text never having arrived. The key rides the row so
    // naming it costs no line.
    expect(folded).toEqual([
      'reasoning · 7 tokens · 5s (shift+tab)',
    ])
    const opened = viewOf(model, { expandCards: false, expandReasoning: true, expandSubCalls: false }).render(60)
    expect(opened).toEqual([
      'reasoning · 7 tokens · 5s',
      '    first thought',
      '    second thought',
    ])
  })
})

describe('TranscriptView picker', () => {
  it('lists stored sessions with a cursor, a filter, and the keys that drive it', () => {
    const picker: PickerCard = {
      title: 'resume a session · 2 stored',
      note: undefined,
      rows: [
        { label: 'fix the parser', description: '/work · 3m ago · 12 events', current: true },
        { label: 'tui-session-b', description: '/tmp · 1d ago', current: false },
      ],
      filter: 'fix',
      hint: '↑/ctrl+p or ↓/ctrl+n move · enter open · esc cancel · type to filter',
      above: 2,
      below: 3,
    }
    const view = new TranscriptView(new TranscriptModel(), theme, new MarkdownRenderer(theme.markdown), {
      picker: () => picker,
    })
    const lines = view.render(80)
    // No glyph by default: the picker's mark is a token now, and the shipped
    // table ships none, so the heading is its words.
    expect(lines).toContain('resume a session · 2 stored')
    expect(lines).toContain('    filter: fix')
    expect(lines).toContain('   ❯ fix the parser — /work · 3m ago · 12 events')
    expect(lines).toContain('     tui-session-b — /tmp · 1d ago')
    expect(lines).toContain('   … 2 newer')
    expect(lines).toContain('   … 3 older')
    expect(lines.some(line => line.includes('enter open'))).toBe(true)
  })

  it('folds the picker keys under a narrow screen instead of cutting the way out off', () => {
    const picker: PickerCard = {
      title: 'resume a session · 2 stored',
      note: undefined,
      rows: [{ label: 'fix the parser', description: '/work · 3m ago', current: true }],
      filter: '',
      hint: '↑/ctrl+p or ↓/ctrl+n move · enter open · esc/ctrl+c cancel · type to filter',
      above: 0,
      below: 0,
    }
    const view = new TranscriptView(new TranscriptModel(), theme, new MarkdownRenderer(theme.markdown), {
      picker: () => picker,
    })
    const lines = view.render(40)
    // The hint is how a reader learns to leave the list, so a narrow screen
    // folds it rather than dropping the keys a press still answers.
    const hint = lines.join(' ').replace(/\s+/gu, ' ')
    expect(hint).toContain('esc/ctrl+c cancel')
    expect(hint).toContain('type to filter')
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40)
  })

  it('wraps the reason a pick was refused under the heading', () => {
    const picker: PickerCard = {
      title: 'resume a session · 1 stored',
      note: 'session tui-session-a runs mode "cordis", so --preset standard does not apply; /preset standard switches it before its first turn',
      rows: [{ label: 'tui-session-a', description: '/work · 3m ago', current: true }],
      filter: '',
      hint: '↑/ctrl+p or ↓/ctrl+n move · enter open · esc cancel · type to filter',
      above: 0,
      below: 0,
    }
    const view = new TranscriptView(new TranscriptModel(), theme, new MarkdownRenderer(theme.markdown), {
      picker: () => picker,
    })
    const lines = view.render(60)
    const heading = lines.findIndex(line => line.includes('resume a session'))
    const row = lines.findIndex(line => line.includes('❯ tui-session-a'))
    // A reason that does not fit has to keep going rather than be cut off.
    const note = lines.slice(heading + 1, row).join(' ').replace(/\s+/gu, ' ')
    expect(note).toContain('session tui-session-a runs mode "cordis"')
    expect(note).toContain('switches it before its first turn')
    expect(lines[heading + 1]?.length).toBeLessThanOrEqual(60)
  })
})

describe('TranscriptView gate', () => {
  it('renders an approval gate with its decision keys', () => {
    const gate: GateCard = {
      kind: 'approval',
      title: 'approval needed · bash',
      detail: ['write outside the workspace'],
      optionOffset: 0,
      options: [],
      custom: undefined,
      answerInput: undefined,
      hint: 'y allow once · n reject · esc cancel',
    }
    const lines = viewOf(new TranscriptModel(), COLLAPSED, gate).render(60)
    expect(lines).toContain('⚠ approval needed · bash')
    expect(lines.some(line => line.includes('write outside the workspace'))).toBe(true)
    expect(lines.some(line => line.includes('y allow once'))).toBe(true)
  })

  it('numbers a windowed row by where it sits in the list, not by where it landed on screen', () => {
    const gate: GateCard = {
      kind: 'question',
      title: 'which target?  (1/2)',
      detail: [],
      optionOffset: 4,
      options: [
        { label: 'staging', description: 'safe', current: true, selected: true },
        { label: 'production', description: undefined, current: false, selected: false },
      ],
      custom: undefined,
      answerInput: undefined,
      hint: 'space select · digits pick · enter confirm · esc skip',
    }
    const lines = viewOf(new TranscriptModel(), COLLAPSED, gate).render(60)
    expect(lines).toContain('? which target?  (1/2)')
    expect(lines).toContain('   ❯ [x] 5. staging — safe')
    expect(lines).toContain('     [ ] 6. production')
  })

  it('keeps a gate answer row inside a surface too narrow for its indent', () => {
    const gate: GateCard = {
      kind: 'question',
      title: 'which target?',
      detail: [],
      optionOffset: 0,
      options: [],
      custom: undefined,
      answerInput: answerBar('answer'),
      hint: '',
    }
    const lines = viewOf(new TranscriptModel(), COLLAPSED, gate).render(4)
    // The indent alone can be as wide as the surface; the answer still has to
    // arrive as rows the surface can draw rather than as rows it must cut.
    expect(lines.every(line => visibleWidth(line) <= 4)).toBe(true)
  })

  it('wraps an option that runs past the screen instead of cutting it', () => {
    const gate: GateCard = {
      kind: 'question',
      title: 'which target?',
      detail: [],
      optionOffset: 0,
      options: [
        { label: 'staging-eu-west-1', description: 'the full canary rollout behind an audit window', current: true, selected: false },
      ],
      custom: undefined,
      answerInput: undefined,
      hint: 'space select · digits pick · enter confirm · esc skip',
    }
    const lines = viewOf(new TranscriptModel(), COLLAPSED, gate).render(40)
    const first = lines.findIndex(line => line.includes('1. staging-eu-west-1'))
    expect(first).toBeGreaterThan(-1)
    // The tail has to stay readable, because the description is what tells two
    // targets apart when their labels look alike.
    const wrapped = lines.slice(first, first + 3)
    expect(wrapped.join(' ')).toContain('audit window')
    // The continuation aligns under the label, not under the cursor mark: a
    // wrap that lands in the marker column reads as another row.
    expect(wrapped[1]).toMatch(/^ {12}\S/u)
    expect(lines.every(line => visibleWidth(line) <= 40)).toBe(true)
  })

  it('draws row 0 under the windowed options, marked while the cursor is on it', () => {
    const gate: GateCard = {
      kind: 'question',
      title: 'which target?  (1/2)',
      detail: [],
      optionOffset: 4,
      options: [{ label: 'staging', description: undefined, current: false, selected: false }],
      custom: { label: 'other', description: 'type your own answer', current: true, selected: true },
      answerInput: undefined,
      hint: 'space select · digits pick · 0 answer freely · type to filter · enter confirm · esc skip',
    }
    const lines = viewOf(new TranscriptModel(), COLLAPSED, gate).render(60)
    const row = lines.findIndex(line => line.includes('0. other'))
    expect(lines[row]).toBe('   ❯ [x] 0. other — type your own answer')
    // Row 0 sits under the window, so the window's own numbering is never interrupted.
    expect(lines.findIndex(line => line.includes('5. staging'))).toBeLessThan(row)
  })

  it('draws the typed answer under row 0, above the keys that name it', () => {
    const gate: GateCard = {
      kind: 'question',
      title: 'which target?',
      detail: ['showing 1–2 of 9'],
      optionOffset: 0,
      options: [{ label: 'staging', description: undefined, current: false, selected: false }],
      custom: { label: 'other', description: 'type your own answer', current: true, selected: true },
      answerInput: answerBar('the eu-central cluster'),
      hint: 'type or paste an answer · enter confirm · ↑↓/ctrl+p/ctrl+n or esc back to options',
    }
    const lines = viewOf(new TranscriptModel(), COLLAPSED, gate).render(60)
    const row = lines.findIndex(line => line.includes('0. other'))
    const answer = lines.findIndex(line => line.includes('the eu-central cluster'))
    // The bar belongs to the row it fills: above the options it reads as
    // something the question says rather than something the reader is typing.
    expect(answer).toBeGreaterThan(row)
    expect(lines.findIndex(line => line.includes('1. staging'))).toBeLessThan(answer)
    expect(lines.findIndex(line => line.includes('type or paste'))).toBeGreaterThan(answer)
  })

  it('draws the answer line of a question that has only text to collect', () => {
    const gate: GateCard = {
      kind: 'question',
      title: 'why?',
      detail: [],
      optionOffset: 0,
      options: [],
      custom: undefined,
      answerInput: answerBar(''),
      hint: 'type or paste an answer · enter confirm · esc skip',
    }
    const lines = viewOf(new TranscriptModel(), COLLAPSED, gate).render(60)
    expect(lines).toContain('? why?')
    // A question with nothing but text to collect still opens the bar, because
    // an empty bar is where the first character of an answer lands.
    expect(lines.some(line => line.startsWith('   │'))).toBe(true)
    expect(lines.findIndex(line => line.startsWith('   │'))).toBeGreaterThan(lines.indexOf('? why?'))
  })

  it('wraps the question and the keys it names rather than cutting them', () => {
    const gate: GateCard = {
      kind: 'question',
      title: 'which deployment target should the release candidate use?',
      detail: [],
      optionOffset: 0,
      options: [],
      custom: undefined,
      answerInput: undefined,
      hint: 'space select · digits pick · 0 answer freely · type to filter · enter confirm · esc skip',
    }
    const lines = viewOf(new TranscriptModel(), COLLAPSED, gate).render(40)
    expect(lines.every(line => visibleWidth(line) <= 40)).toBe(true)
    // The question's own words and the last key it names both survive the edge.
    expect(lines.join(' ')).toContain('release candidate use?')
    expect(lines.join(' ')).toContain('esc skip')
  })
})

describe('TranscriptView theming', () => {
  const userModel = (): TranscriptModel => {
    const model = new TranscriptModel()
    model.apply({ type: 'user/message', data: { content: [{ type: 'text', text: 'hello there' }], source: { kind: 'user' } } })
    return model
  }

  it('dresses a prompt in its mint shade without the weight', () => {
    const colour = createTheme('truecolor')
    const lines = new TranscriptView(userModel(), colour, new MarkdownRenderer(colour.markdown), { state: () => COLLAPSED }).render(40)
    expect(lines.join('\n')).toContain('\u001b[38;2;39;245;200mhello there\u001b[0m')
    expect(lines.join('\n')).not.toContain('\u001b[1;')
  })

  it('draws a prompt bare when the frame is hidden', () => {
    const bare = createTheme('truecolor', { palette: DEFAULT_PALETTE, tokens: new Map([['editor.border', { hidden: true }]]) })
    const lines = new TranscriptView(userModel(), bare, new MarkdownRenderer(bare.markdown), { state: () => COLLAPSED }).render(40)
    expect(lines).toHaveLength(1)
    // No frame, but the text keeps the column the frame's own air gave it, so a
    // theme that hides the border does not move the prompt.
    expect(lines[0]?.trimEnd()).toBe(' \u001b[38;2;39;245;200mhello there\u001b[0m')
  })

  it("draws a reply's frame in the assistant border shade", () => {
    const model = new TranscriptModel()
    model.apply({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'the answer' }] } } })
    const colour = createTheme('truecolor')
    const lines = new TranscriptView(model, colour, new MarkdownRenderer(colour.markdown), { state: () => COLLAPSED }).render(40)
    // #d6c29a, the shade the shipped table gives the reply's own frame.
    expect(lines[0]).toContain('38;2;214;194;154')
    expect(lines.at(-1)).toContain('38;2;214;194;154')
  })

  it('draws a reply bare when its frame element is hidden', () => {
    const model = new TranscriptModel()
    model.apply({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'the answer' }] } } })
    const bare = createTheme('truecolor', { palette: DEFAULT_PALETTE, tokens: new Map([['transcript.assistant.border', { hidden: true }]]) })
    const lines = new TranscriptView(model, bare, new MarkdownRenderer(bare.markdown), { state: () => COLLAPSED }).render(40)
    expect(lines).toHaveLength(1)
    // No frame, but the text keeps the column the frame's own air gave it, so a
    // theme that hides the border does not move the reply.
    expect(lines[0]?.trimEnd()).toBe(' the answer')
  })

  it('draws nothing for a hidden element', () => {
    const hidden = createTheme('truecolor', { palette: DEFAULT_PALETTE, tokens: new Map([['transcript.user', { hidden: true }]]) })
    const lines = new TranscriptView(userModel(), hidden, new MarkdownRenderer(hidden.markdown), { state: () => COLLAPSED }).render(60)
    expect(lines.join('\n')).not.toContain('hello')
  })

  it('draws no empty indented row when every part of a card row is hidden', () => {
    const model = new TranscriptModel()
    model.apply(toolCall())
    model.apply(toolResult('boom'))
    const hidden = createTheme('truecolor', { palette: DEFAULT_PALETTE, tokens: new Map([['tool.generic.detail', { hidden: true }]]) })
    const lines = new TranscriptView(model, hidden, new MarkdownRenderer(hidden.markdown), { state: () => COLLAPSED }).render(60)
    expect(lines.filter(line => line.trim() === '' && line !== '')).toEqual([])
  })

  it('hides a reasoning body without hiding its summary', () => {
    const model = new TranscriptModel()
    model.apply({ type: 'assistant/message', data: {
      message: { content: [{ type: 'reasoning', text: 'secret thought' }, { type: 'text', text: 'the answer' }] },
    } })
    const hidden = createTheme('truecolor', { palette: DEFAULT_PALETTE, tokens: new Map([['transcript.reasoning.body', { hidden: true }]]) })
    const lines = new TranscriptView(model, hidden, new MarkdownRenderer(hidden.markdown), {
      state: () => ({ expandCards: false, expandReasoning: true, expandSubCalls: false }),
    }).render(60)
    expect(lines.join('\n')).not.toContain('secret thought')
    expect(lines.join('\n')).toContain('reasoning ·')
  })

  it('draws a diff inside a thought in the diff elements', () => {
    // A thought refuses the answer's drawings and shades, but a diff is the change
    // itself rather than decoration: a reader following a thought has to see which
    // side of it moved, while everything else the thought says stays recessive.
    const model = new TranscriptModel()
    model.apply({ type: 'assistant/message', data: {
      message: {
        content: [
          { type: 'reasoning', text: ['thinking about the change', '', '```diff', '-const a = 1', '+const a = 2', '```'].join('\n') },
          { type: 'text', text: 'the answer' },
        ],
      },
    } })
    const colour = createTheme('truecolor')
    const lines = new TranscriptView(model, colour, new MarkdownRenderer(colour.markdown), {
      state: () => ({ expandCards: false, expandReasoning: true, expandSubCalls: false }),
    }).render(60)
    const shown = lines.join('\n')
    const rgb = (hex: string) => [1, 3, 5].map(at => Number.parseInt(hex.slice(at, at + 2), 16)).join(';')
    expect(shown).toContain(`38;2;${rgb(DEFAULT_PALETTE.added)}`)
    expect(shown).toContain(`48;2;${rgb(DIFF_ADDED_BAND)}`)
    expect(shown).toContain(`38;2;${rgb(DEFAULT_PALETTE.faint)}`)
  })

  it('rebuilds cached rows when the theme revision moves', () => {
    let active = createTheme('truecolor')
    const delegate: TuiTheme = {
      get revision() { return active.revision },
      get color() { return active.color },
      style: (token, text) => active.style(token, text),
      rich: (raw, options) => active.rich(raw, options),
      cut: (text, width, ellipsis) => active.cut(text, width, ellipsis),
      glyph: token => active.glyph(token),
      visible: token => active.visible(token),
      editor: forwardEditorTheme(() => active.editor),
      markdown: forwardMarkdownTheme(() => active.markdown),
    }
    const markdown = new MarkdownRenderer(delegate.markdown)
    const view = new TranscriptView(userModel(), delegate, markdown, { state: () => COLLAPSED })
    // Derived rather than repeated: this test is about the cache rebuilding,
    // not about which shade the prompt wears.
    const shipped = [1, 3, 5].map(at => Number.parseInt(DEFAULT_PALETTE.user.slice(at, at + 2), 16))
    expect(view.render(60).join('\n')).toContain(`38;2;${shipped.join(';')}`)
    active = createTheme('truecolor', { palette: DEFAULT_PALETTE, tokens: new Map([['transcript.user', { fg: '#ff0000' }]]) })
    // A settings change drops both caches, as the surface does; the row cache is
    // keyed to the old revision, so the repaint re-draws the row under the new table.
    markdown.invalidate()
    expect(view.render(60).join('\n')).toContain('38;2;255;0;0')
  })
})

describe('TranscriptView tool args and stats', () => {
  /** Fold one call and result through a presenter, so the merge is what renders. */
  const folded = (name: string, presenter: ToolPresenter, width = 80, state: ViewState = COLLAPSED): string[] => {
    const model = new TranscriptModel(presenter)
    model.apply({ type: 'tool/call', data: { name, arguments: '{}', callId: 'c1' } })
    model.apply({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', text: 'body' }], isError: false } } })
    return viewOf(model, state).render(width)
  }

  it('shows a read path with its range, size, and tokens on the folded line', () => {
    const presenter: ToolPresenter = {
      call: name => cardOfCall({ card: 'generic', title: 'Read a.ts (from line 5)', kind: 'read', locations: [{ path: 'a.ts', line: 5 }] }, name),
      result: (name, input) => cardOfResult(
        { card: 'read', path: 'a.ts', offset: 5, lines: [{ number: 5, text: 'x' }, { number: 6, text: 'y' }], totalLines: 20 },
        { name: name, failed: input.isError, contentLines: contentLines(input.content) },
      ),
    }
    expect(folded('read', presenter)).toEqual(['read a.ts  L5–6 · 2 lines · 1 tok'])
  })

  it('shows a new file by its line and token size', () => {
    const presenter: ToolPresenter = {
      call: name => cardOfCall({ card: 'diff', title: 'Write a.txt', diffs: [{ path: 'a.txt', oldText: null, newText: 'one\ntwo\nthree' }] }, name),
      result: (name, input) => cardOfResult(
        { card: 'diff', diffs: [{ path: 'a.txt', oldText: null, newText: 'one\ntwo\nthree' }] },
        { name: name, failed: input.isError, contentLines: contentLines(input.content) },
      ),
    }
    expect(folded('write', presenter)).toEqual(['write a.txt  3 lines · 4 tok'])
  })

  it('shows an edit split into added and changed lines', () => {
    const diffs = [{ path: 'a.ts', oldText: 'a\nb', newText: 'a\nx\ny' }]
    const presenter: ToolPresenter = {
      call: name => cardOfCall({ card: 'diff', title: 'Edit a.ts', diffs }, name),
      result: (name, input) => cardOfResult(
        { card: 'diff', diffs },
        { name: name, failed: input.isError, contentLines: contentLines(input.content) },
      ),
    }
    expect(folded('edit', presenter)).toEqual(['edit a.ts  +1 · ~1'])
  })

  it('hides a stat whose token the reader turned off', () => {
    const diffs = [{ path: 'a.ts', oldText: 'a\nb', newText: 'a\nx\ny' }]
    const presenter: ToolPresenter = {
      call: name => cardOfCall({ card: 'diff', title: 'Edit a.ts', diffs }, name),
      result: (name, input) => cardOfResult(
        { card: 'diff', diffs },
        { name: name, failed: input.isError, contentLines: contentLines(input.content) },
      ),
    }
    const model = new TranscriptModel(presenter)
    model.apply({ type: 'tool/call', data: { name: 'edit', arguments: '{}', callId: 'c1' } })
    model.apply({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', text: 'body' }], isError: false } } })
    const muted = createTheme('none', { palette: DEFAULT_PALETTE, tokens: new Map([['tool.stat.added', { hidden: true }]]) })
    const lines = new TranscriptView(model, muted, new MarkdownRenderer(muted.markdown), { state: () => COLLAPSED }).render(80)
    expect(lines).toEqual(['edit a.ts  ~1'])
  })

  it('wraps a command wider than the screen instead of cutting it', () => {
    const command = `/bin/echo ${'x'.repeat(60)}`
    const presenter: ToolPresenter = {
      call: name => cardOfCall({ card: 'terminal', title: command }, name),
      result: (name, input) => cardOfResult(
        { card: 'terminal', output: 'ok', exitCode: 0 },
        { name: name, failed: input.isError, contentLines: contentLines(input.content) },
      ),
    }
    const lines = folded('bash', presenter, 40, OPEN)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(40)
    // Word wrapping drops the whitespace it broke on, so compare without it.
    expect(lines.join('').replace(/\s+/gu, '')).toContain(command.replace(/\s+/gu, ''))
  })

  it('wraps a long argument and keeps its stats instead of cutting the tail', () => {
    const path = `/tmp/${'nested/'.repeat(8)}file.ts`
    const presenter: ToolPresenter = {
      call: name => cardOfCall({ card: 'generic', title: 'Read', kind: 'read', locations: [{ path }] }, name),
      result: (name, input) => cardOfResult(
        { card: 'read', path, offset: 1, lines: [{ number: 1, text: 'x' }], totalLines: 1 },
        { name: name, failed: input.isError, contentLines: contentLines(input.content) },
      ),
    }
    const lines = folded('read', presenter, 40, OPEN)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(40)
    // The stats are as much the fold's answer as the path is, so neither may be
    // dropped at the edge the way a plain cut dropped them.
    const flat = lines.join('').replace(/\s+/gu, '')
    expect(flat).toContain(path)
    expect(flat).toContain('1tok')
  })

  it('shows a skill card without the presenter verb in front of it', () => {
    const presenter: ToolPresenter = {
      call: name => cardOfCall({ card: 'generic', title: 'Load skill project-skill', kind: 'read', rawInput: 'project-skill' }, name),
      result: () => undefined,
    }
    expect(folded('skill', presenter)).toEqual(['skill project-skill'])
  })

  it('measures a wrapped command by its visible width, not its escape bytes', () => {
    // A styled argument carries escapes through the wrap; if those count as
    // columns the card overflows the terminal it was cut for.
    const command = `/bin/echo ${'x'.repeat(60)}`
    const presenter: ToolPresenter = {
      call: name => cardOfCall({ card: 'terminal', title: command }, name),
      result: (name, input) => cardOfResult(
        { card: 'terminal', output: 'ok', exitCode: 0 },
        { name: name, failed: input.isError, contentLines: contentLines(input.content) },
      ),
    }
    const colour = createTheme('truecolor')
    const model = new TranscriptModel(presenter)
    model.apply({ type: 'tool/call', data: { name: 'bash', arguments: '{}', callId: 'c1' } })
    model.apply({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', text: 'ok' }], isError: false } } })
    const lines = new TranscriptView(model, colour, new MarkdownRenderer(colour.markdown), { state: () => OPEN }).render(40)
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40)
    expect(stripTerminalSequences(lines.join('')).replace(/\s+/gu, '')).toContain(command.replace(/\s+/gu, ''))
  })

  it('folds a long command onto one row, cut at the screen rather than wrapped', () => {
    const command = `/bin/echo ${'x'.repeat(60)}`
    const presenter: ToolPresenter = {
      call: name => cardOfCall({ card: 'terminal', title: command }, name),
      result: (name, input) => cardOfResult(
        { card: 'terminal', output: 'ok', exitCode: 0 },
        { name, failed: input.isError, contentLines: contentLines(input.content) },
      ),
    }
    const lines = folded('bash', presenter, 30)
    // The fold's whole promise is one row, so the argument is clipped and the row
    // is cut at the edge; the reader sees it was cut and can open it whole.
    expect(lines).toHaveLength(1)
    expect(visibleWidth(lines[0] ?? '')).toBeLessThanOrEqual(30)
    expect(stripTerminalSequences(lines[0] ?? '')).toContain('…')
  })
})

describe('TranscriptView tool display policy', () => {
  /** A shell run of `rows` output lines, through the real card mappers. */
  const shell = (rows: number): TranscriptModel => {
    const output = Array.from({ length: rows }, (_, index) => `row ${index}`)
    const presenter: ToolPresenter = {
      call: name => cardOfCall({ card: 'terminal', title: 'Run echo rows' }, name),
      result: (name, input) => cardOfResult(
        { card: 'terminal', title: 'Run echo rows', output: contentLines(input.content).join('\n'), exitCode: 0 },
        { name, failed: input.isError, contentLines: contentLines(input.content) },
      ),
    }
    const model = new TranscriptModel(presenter)
    model.apply({ type: 'tool/call', data: { name: 'bash', arguments: '{}', callId: 'c1' } })
    model.apply({
      type: 'tool/result',
      data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', text: output.join('\n') }], isError: false } },
    })
    return model
  }

  /** Two folded shell cards, so a click on one can be shown not to touch the other. */
  const pair = (): TranscriptModel => {
    const presenter: ToolPresenter = {
      call: name => cardOfCall({ card: 'terminal', title: 'echo' }, name),
      result: (name, input) => cardOfResult(
        { card: 'terminal', output: contentLines(input.content).join('\n'), exitCode: 0 },
        { name, failed: input.isError, contentLines: contentLines(input.content) },
      ),
    }
    const model = new TranscriptModel(presenter)
    for (const [callId, text] of [['c1', 'one'], ['c2', 'two']] as const) {
      model.apply({ type: 'tool/call', data: { name: 'bash', arguments: '{}', callId } })
      model.apply({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: callId, text }], isError: false } } })
    }
    return model
  }

  it('starts a tool open when the reader configured it that way', () => {
    const view = viewOf(shell(3), COLLAPSED, undefined, toolDisplayTable({ bash: { collapsed: false } }))
    expect(view.render(60).filter(line => line.startsWith('    row '))).toHaveLength(3)
  })

  it('clips the argument to the screen edge, leaving the right edge blank', () => {
    // The facts and the outcome keep their columns: a narrow screen costs the
    // argument, not the answer to "what ran, and how did it end".
    const [line = ''] = viewOf(shell(3), COLLAPSED).render(30)
    expect(visibleWidth(line)).toBe(25)
    expect(line).toContain('…')
    expect(line.endsWith('· exit 0 · 3 lines')).toBe(true)
  })

  it('keeps the configured tail behind a folded card and counts the rest', () => {
    const view = viewOf(shell(25), COLLAPSED, undefined, toolDisplayTable({ bash: { output: 'tail', tail: 2 } }))
    const lines = view.render(60)
    expect(lines.filter(line => line.startsWith('    row '))).toEqual(['    row 23', '    row 24'])
    expect(lines.at(-1)).toBe('    … 23 earlier lines · ctrl+o shows more')
  })

  it('ships the fold the settings document names, not a hard-coded one', () => {
    // The shipped default has to be the one the settings types describe, or a
    // reader who writes nothing gets a different screen than the docs promise.
    const view = viewOf(shell(3), COLLAPSED, undefined, toolDisplayTable())
    expect(view.render(60)).toEqual(['bash Run echo rows · exit 0 · 3 lines'])
    expect(DEFAULT_TOOL_DISPLAY).toEqual({ collapsed: true, output: 'hidden', tail: CARD_SHELL_PREVIEW })
  })

  it('toggles one clicked message and leaves its neighbour alone', () => {
    const view = viewOf(pair())
    const folded = ['bash echo · exit 0 · 1 line', 'bash echo · exit 0 · 1 line']
    expect(view.render(60)).toEqual(folded)
    // A click opens the message under it and nothing else.
    expect(view.handleMouse(mouse('click', 'left', 0))).toEqual({ handled: true, render: true })
    const opened = view.render(60)
    expect(opened).toContain('    one')
    expect(opened.at(-1)).toBe(folded[1])
    // The choice survives the repaints around it, and a second click reverses it.
    expect(view.render(60)).toEqual(opened)
    view.handleMouse(mouse('click', 'left', 0))
    expect(view.render(60)).toEqual(folded)
  })

  it('leaves presses, drags, wheels, and other buttons to the surface', () => {
    const view = viewOf(pair())
    view.render(60)
    for (const event of [mouse('press', 'left', 0), mouse('drag', 'left', 0), mouse('wheel', 'none', 0), mouse('click', 'right', 0)]) {
      expect(view.handleMouse(event)).toBeUndefined()
    }
    expect(view.render(60)).toEqual(['bash echo · exit 0 · 1 line', 'bash echo · exit 0 · 1 line'])
  })

  it('leaves a click outside every card to the transcript itself', () => {
    const view = viewOf(pair())
    view.render(60)
    expect(view.handleMouse(mouse('click', 'left', 9))).toBeUndefined()
  })
})

describe('TranscriptView nested PTC calls', () => {
  /** Declares each nested call the way the real tools do, so its row is the tool's own header. */
  const nestedPresenter: ToolPresenter = {
    call: (name, argumentsJson) => {
      if (name === 'run_code') return cardOfCall({ card: 'generic', title: 'search the tree' }, name)
      const args = JSON.parse(argumentsJson) as Record<string, unknown>
      if (typeof args.command === 'string') return cardOfCall({ card: 'terminal', title: args.command }, name)
      // An edit declares the change it is about to make, which is the only place
      // its diff exists: the dispatch carries no result metadata to re-present.
      if (typeof args.old_string === 'string') {
        return cardOfCall({ card: 'diff', title: 'Edit', diffs: [{ path: String(args.file_path ?? ''), oldText: args.old_string, newText: String(args.new_string ?? '') }] }, name)
      }
      return cardOfCall({ card: 'generic', title: 'Read', kind: 'read', locations: [{ path: String(args.file_path ?? '') }] }, name)
    },
    result: (name, input) => name === 'bash'
      ? cardOfResult(
          // The real shell reports the exit code it ended on, which is the status a
          // reader sees on the row; a failed call in these fixtures exits non-zero.
          { card: 'terminal', output: contentLines(input.content).join('\n'), exitCode: input.isError ? 1 : 0 },
          { name, failed: input.isError, contentLines: contentLines(input.content) },
        )
      : undefined,
  }

  /** One run_code program, its dispatches, and their results, in the order the log records them. */
  const foldedProgram = (calls: readonly { readonly name: string; readonly args: Record<string, unknown>; readonly failed?: boolean; readonly content?: string }[]): TranscriptModel => {
    const model = new TranscriptModel(nestedPresenter)
    model.apply({ type: 'tool/call', data: { name: 'run_code', arguments: '{"description":"search the tree"}', callId: 'root' } })
    calls.forEach((call, at) => {
      const subCallId = `root:ptc:${at + 1}`
      model.apply({ type: 'tool/ptc-dispatch-start', data: { rootCallId: 'root', parentCallId: 'root', subCallId, name: call.name, arguments: call.args } })
      const content = call.content === undefined ? [] : [{ type: 'text', text: call.content }]
      model.apply({ type: 'tool/ptc-dispatch', data: { rootCallId: 'root', parentCallId: 'root', subCallId, name: call.name, arguments: call.args, isError: call.failed === true, content } })
    })
    model.apply({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'root', text: 'done' }], isError: false } } })
    return model
  }

  const INLINE: ViewState = { expandCards: true, expandReasoning: false, expandSubCalls: true }
  /** The shipped shape: the card folded, the calls it dispatched still legible. */
  const FOLDED: ViewState = { expandCards: false, expandReasoning: false, expandSubCalls: true }

  it('hides a program’s calls when the nested-call toggle is off', () => {
    const lines = viewOf(foldedProgram([{ name: 'read', args: { file_path: 'src/x.ts' } }])).render(60)
    expect(lines[0]).toBe('search the tree')
    expect(lines.some(line => line.includes('src/x.ts'))).toBe(false)
  })

  it('keeps each dispatch on one line under a card that stays folded', () => {
    const model = foldedProgram([
      { name: 'read', args: { file_path: 'src/x.ts' } },
      { name: 'bash', args: { command: 'git status' } },
    ])
    const lines = viewOf(model, FOLDED).render(60)
    expect(lines[0]).toBe('search the tree')
    // Only the call still in flight is marked, so a settled row takes the mark's
    // place and the names read down one column.
    expect(lines.slice(1)).toEqual(['  read src/x.ts', '  bash git status · exit 0'])
  })

  it('keeps a dispatched command that carries a break on one row', () => {
    const model = foldedProgram([{ name: 'bash', args: { command: 'echo one\necho two' } }])
    expect(viewOf(model, FOLDED).render(60)).toEqual(['search the tree', '  bash echo one echo two · exit 0'])
  })

  it('draws each call on one two-space-indented line under the header', () => {
    const model = foldedProgram([
      { name: 'read', args: { file_path: 'src/x.ts' } },
      { name: 'bash', args: { command: 'git status' } },
    ])
    expect(viewOf(model, INLINE).render(60)).toEqual(['search the tree', '  read src/x.ts', '  bash git status · exit 0', '    done'])
  })

  it('marks a failed call in the failed colour without hiding it', () => {
    const colour = createTheme('truecolor')
    const model = foldedProgram([{ name: 'bash', args: { command: 'exit 1' }, failed: true }])
    const lines = new TranscriptView(model, colour, new MarkdownRenderer(colour.markdown), { state: () => INLINE }).render(60)
    // A failed call is not marked: its own name is drawn in the failed colour, so
    // the row a reader scans says which call went wrong and nothing beside it is
    // claimed to have failed.
    expect(stripTerminalSequences(lines[1] ?? '')).toBe('  bash exit 1 · exit 1')
    expect(lines[1]).toContain(painted(DEFAULT_PALETTE.removed))
  })

  it('reports the calls retention dropped', () => {
    const calls = Array.from({ length: SUBCALL_MAX + 1 }, (_, at) => ({ name: 'read', args: { file_path: `src/${at}.ts` } }))
    const lines = viewOf(foldedProgram(calls), INLINE).render(60)
    expect(lines).toContain('  … 1 more calls')
  })

  it('opens a dispatched shell call to the rows it printed', () => {
    const model = foldedProgram([
      { name: 'bash', args: { command: 'echo hi' }, content: 'hi\nthere' },
      { name: 'read', args: { file_path: 'src/y.ts' } },
    ])
    const view = viewOf(model, FOLDED)
    expect(view.render(60)).toEqual(['search the tree', '  bash echo hi · exit 0', '  read src/y.ts'])
    // The output is the reason to open the row, and only the clicked call gets it.
    view.handleMouse(mouse('click', 'left', 1))
    expect(view.render(60)).toEqual(['search the tree', '  bash echo hi · exit 0', '    hi', '    there', '  read src/y.ts'])
    // A click anywhere on the opened call closes it, output and all.
    view.handleMouse(mouse('click', 'left', 2))
    expect(view.render(60)).toEqual(['search the tree', '  bash echo hi · exit 0', '  read src/y.ts'])
  })

  it('clips a call to one row and opens that call when it is clicked', () => {
    const model = foldedProgram([
      { name: 'bash', args: { command: `echo ${'x'.repeat(80)}` } },
      { name: 'read', args: { file_path: 'src/y.ts' } },
    ])
    const view = viewOf(model, FOLDED)
    const folded = view.render(40)
    expect(folded[0]).toBe('search the tree')
    expect(folded[1]?.startsWith('  bash echo ')).toBe(true)
    expect(folded[1] ?? '').toContain('…')
    // The clipped call stops five columns short of the edge, like every other
    // one-line tool row.
    expect(visibleWidth(folded[1] ?? '')).toBe(35)
    expect(folded[2]).toBe('  read src/y.ts')
    for (const line of folded) expect(visibleWidth(line)).toBeLessThanOrEqual(40)
    // The click takes the tightest row it lands on: the call opens in full while
    // the card around it and the call below stay as they were.
    expect(view.handleMouse(mouse('click', 'left', 1))).toEqual({ handled: true, render: true })
    const opened = view.render(40)
    expect(opened[0]).toBe('search the tree')
    expect(opened.at(-1)).toBe('  read src/y.ts')
    // The full argument survives across the wrapped rows, which is the point of
    // opening one call without opening the card around it.
    // The last row ends with the call's own outcome, which is not part of the
    // argument this asserts survived the wrap.
    const wrapped = opened.slice(1, -1).map(row => (row.split(' · ')[0] ?? '').trim()).join('')
    expect(wrapped.split('x')).toHaveLength(81)
    expect(opened.join('')).not.toContain('done')
    for (const line of opened) expect(visibleWidth(line)).toBeLessThanOrEqual(40)
    // Clicking the opened call folds it back to the one line it started as.
    view.handleMouse(mouse('click', 'left', 1))
    expect(view.render(40)).toEqual(folded)
  })

  it('opens a dispatched edit to its diff and its outcome, in that order', () => {
    const colour = createTheme('truecolor')
    const model = foldedProgram([{ name: 'edit', args: { file_path: 'src/x.ts', old_string: 'b', new_string: 'B' }, content: 'The file src/x.ts has been updated successfully.' }])
    const view = new TranscriptView(model, colour, new MarkdownRenderer(colour.markdown), { state: () => FOLDED })
    const folded = view.render(60).map(stripTerminalSequences)
    expect(folded).toEqual(['search the tree', '  edit src/x.ts'])
    // A click only lands on a row the surface has already drawn its hit target on.
    view.handleMouse(mouse('click', 'left', 1))
    const opened = view.render(60)
    expect(opened.map(stripTerminalSequences)).toEqual([
      'search the tree',
      '  edit src/x.ts',
      '    src/x.ts  -1 +1',
      '    -b',
      '    +B',
      '    The file src/x.ts has been updated successfully.',
    ])
    // The change draws in the diff colours, which is what the row is opened for.
    const removed = [1, 3, 5].map(at => Number.parseInt(DEFAULT_PALETTE.removed.slice(at, at + 2), 16))
    const added = [1, 3, 5].map(at => Number.parseInt(DEFAULT_PALETTE.added.slice(at, at + 2), 16))
    expect(opened[3]).toContain(`38;2;${removed.join(';')}`)
    expect(opened[4]).toContain(`38;2;${added.join(';')}`)
    // A click on the drawn diff folds the call back to the one line it started as.
    view.handleMouse(mouse('click', 'left', 4))
    expect(view.render(60).map(stripTerminalSequences)).toEqual(folded)
  })

  it('names the rows retention dropped from what a call opened to', () => {
    const body = Array.from({ length: CARD_DETAIL_MAX + 3 }, (_, at) => `line ${at + 1}`).join('\n')
    const view = viewOf(foldedProgram([{ name: 'read', args: { file_path: 'src/big.ts' }, content: body }]), FOLDED)
    view.render(60)
    view.handleMouse(mouse('click', 'left', 1))
    // The row keeps what the program was shown, and says how much retention refused.
    expect(view.render(60).map(stripTerminalSequences).at(-1)).toBe('    3 more lines not shown')
  })
})

describe('TranscriptView running cards', () => {
  /** A clock the test moves, so a duration on a row is an assertion, not a race. */
  const clockAt = (start: number) => {
    const state = { now: start }
    return { state, clock: () => state.now }
  }

  const CALL = { type: 'tool/call', data: { name: 'bash', arguments: '{"command":"pnpm test"}', callId: 'c1' } }
  const RESULT = {
    type: 'tool/result',
    data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', text: 'all green' }], isError: false } },
  }

  /** A view over one call, folded like the shipped default. */
  const runningView = (start = 1_000, state: ViewState = COLLAPSED) => {
    const { state: clockState, clock } = clockAt(start)
    const model = new TranscriptModel(bashPresenter, clock)
    model.apply(CALL)
    return { clockState, model, view: viewOf(model, state) }
  }

  it('marks a call that has not answered, with the time it has been waiting', () => {
    const { clockState, view } = runningView()
    clockState.now += 12 * SECOND_MS
    // The command stays on the row it was drawn on: the state is added in front
    // of it and the duration beside it, rather than replacing what the reader was
    // already reading.
    expect(view.render(60)).toEqual(['bash pnpm test · ~12s'])
  })

  it('shows the running colour alone while the wait is still under a second', () => {
    const { clockState, view } = runningView()
    clockState.now += 400
    // A duration that has to be rounded up from nothing is noise, not a measurement.
    expect(view.render(60)).toEqual(['bash pnpm test'])
  })

  it('drops the running colour and reports the outcome when the result lands', () => {
    const { clockState, model, view } = runningView()
    clockState.now += 12 * SECOND_MS
    expect(view.render(60)).toEqual(['bash pnpm test · ~12s'])
    model.apply(RESULT)
    // The settled row reports what the call produced, which supersedes the wait.
    expect(view.render(60)).toEqual(['bash pnpm test · exit 0 · 1 line'])
  })

  it('keeps the running colour on an opened card', () => {
    const { clockState, view } = runningView(1_000, OPEN)
    clockState.now += 3 * SECOND_MS
    expect(view.render(60)).toEqual(['bash · ~3s', '    pnpm test'])
  })

  it("leaves a settled card's elapsed time out of the row it keeps", () => {
    const { clockState, model, view } = runningView()
    clockState.now += 9 * SECOND_MS
    expect(view.render(60).join('')).toContain('~9s')
    model.apply(RESULT)
    // A settled row must not keep a duration that keeps growing after the call
    // came back; the number it reports from here is the outcome's own.
    expect(view.render(60).join('')).not.toContain('~')
  })

  it('marks the dispatch the program is waiting on inside a PTC card', () => {
    const { state: clockState, clock } = clockAt(1_000)
    // The shell answers for bash alone, so the root keeps the fallback row a
    // presenter-less run_code would draw.
    const shell: ToolPresenter = {
      call: (name, argumentsJson) => (name === 'bash'
        ? cardOfCall({ card: 'terminal', title: (JSON.parse(argumentsJson) as { command?: string }).command ?? '' }, name)
        : undefined),
      result: () => undefined,
    }
    const model = new TranscriptModel(shell, clock)
    model.apply({ type: 'tool/call', data: { name: 'run_code', arguments: '{"code":"x"}', callId: 'root' } })
    model.apply({
      type: 'tool/ptc-dispatch-start',
      data: { rootCallId: 'root', parentCallId: 'root', subCallId: 'root:ptc:1', name: 'bash', arguments: { command: 'echo hi' } },
    })
    const inline: ViewState = { expandCards: false, expandReasoning: false, expandSubCalls: true }
    clockState.now += 12 * SECOND_MS
    // The program's own row carries the timer and nothing else: it is the clock a
    // reader watches, and the calls underneath it are what it is spending time on.
    expect(viewOf(model, inline).render(60)).toEqual(['run_code · ~12s', '  bash echo hi'])

    model.apply({
      type: 'tool/ptc-dispatch',
      data: { rootCallId: 'root', parentCallId: 'root', subCallId: 'root:ptc:1', name: 'bash', arguments: { command: 'echo hi' }, isError: false, content: [] },
    })
    expect(viewOf(model, inline).render(60)).toEqual(['run_code · ~12s', '  bash echo hi'])
  })

  it('marks only the call a program is still waiting on', () => {
    const { state: clockState, clock } = clockAt(1_000)
    const model = new TranscriptModel(bashPresenter, clock)
    model.apply({ type: 'tool/call', data: { name: 'run_code', arguments: '{"code":"x"}', callId: 'root' } })
    const start = (id: string, command: string) => model.apply({
      type: 'tool/ptc-dispatch-start',
      data: { rootCallId: 'root', parentCallId: 'root', subCallId: id, name: 'bash', arguments: { command } },
    })
    const land = (id: string, command: string, isError: boolean) => model.apply({
      type: 'tool/ptc-dispatch',
      data: { rootCallId: 'root', parentCallId: 'root', subCallId: id, name: 'bash', arguments: { command }, isError, content: [] },
    })
    start('root:ptc:1', 'echo first')
    land('root:ptc:1', 'echo first', false)
    start('root:ptc:2', 'exit 3')
    land('root:ptc:2', 'exit 3', true)
    start('root:ptc:3', 'sleep 30')
    const inline: ViewState = { expandCards: false, expandReasoning: false, expandSubCalls: true }
    clockState.now += 4 * SECOND_MS
    // The call still in flight is the only row that sits further in: the two that
    // are back say how they ended, and the one that failed says it in its own
    // name, so the mark means one thing on every row of the card.
    expect(viewOf(model, inline).render(60)).toEqual([
      'run_code · ~4s',
      '  bash echo first · exit 0',
      '  bash exit 3 · exit 1',
      '  bash sleep 30',
    ])
  })

  it('keeps the total a program took after it answers, and stops counting', () => {
    const rows = new RowCache<TranscriptEntry>()
    const { state: clockState, clock } = clockAt(1_000)
    const model = new TranscriptModel(undefined, clock)
    model.apply({ type: 'tool/call', data: { name: 'run_code', arguments: '{"code":"x"}', callId: 'root' } })
    model.apply({
      type: 'tool/ptc-dispatch-start',
      data: { rootCallId: 'root', parentCallId: 'root', subCallId: 'root:ptc:1', name: 'bash', arguments: { command: 'echo hi' } },
    })
    const inline: ViewState = { expandCards: false, expandReasoning: false, expandSubCalls: true }
    const view = new TranscriptView(model, theme, new MarkdownRenderer(theme.markdown), { rows, state: () => inline })
    clockState.now += 10 * SECOND_MS
    expect(view.render(60)[0]).toBe('run_code · ~10s')

    // Nothing may be left in flight, or the row would keep being rebuilt and the
    // seconds it settled on would never be the row the cache holds.
    model.apply({
      type: 'tool/ptc-dispatch',
      data: { rootCallId: 'root', parentCallId: 'root', subCallId: 'root:ptc:1', name: 'bash', arguments: { command: 'echo hi' }, isError: false, content: [] },
    })
    model.apply({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'root', text: 'done' }], isError: false } } })
    const settled = view.render(60)
    expect(settled[0]).toContain('~10s')
    const misses = rows.stats().misses
    clockState.now += 30 * SECOND_MS
    // The total belongs to the run, not to the clock: a program that answered
    // keeps the row it settled into, at the seconds it actually took.
    expect(view.render(60)).toEqual(settled)
    expect(rows.stats().misses).toBe(misses)
  })

  it('paints the name rather than marking it, in the colour of the state it is in', () => {
    const colour = createTheme('truecolor')
    const { state: clockState, clock } = clockAt(1_000)
    const model = new TranscriptModel(bashPresenter, clock)
    model.apply(CALL)
    clockState.now += 5 * SECOND_MS
    const row = (): string => new TranscriptView(model, colour, new MarkdownRenderer(colour.markdown), { state: () => COLLAPSED }).render(60)[0] ?? ''
    // The name is what a state repaints, and a settled row's stats are free to
    // keep colours of their own, so the paint before the name is what is read.
    const paintBeforeName = (text: string): string => text.slice(0, text.indexOf('bash'))
    // A state is a colour on a word the reader needs either way, so there is no
    // glyph to learn and none to lose: one name, painted two ways.
    expect(paintBeforeName(row())).toContain(painted(DEFAULT_PALETTE.warn))
    model.apply(RESULT)
    expect(paintBeforeName(row())).not.toContain(painted(DEFAULT_PALETTE.warn))
  })

  it('draws the name plainly when the reader has turned the running colour off', () => {
    const { clockState, model } = runningView()
    clockState.now += 5 * SECOND_MS
    const blind = createTheme('none', { palette: DEFAULT_PALETTE, tokens: new Map([['tool.running.title', { hidden: true }]]) })
    const view = new TranscriptView(model, blind, new MarkdownRenderer(blind.markdown), { state: () => COLLAPSED })
    // The colour is what a state token takes away: a reader who turned the running
    // colour off still has to be able to see which tool is running, and the
    // measurement is what still says it has not come back.
    expect(view.render(60)).toEqual(['bash pnpm test · ~5s'])
  })

  it('draws the total a program kept quieter than the timer it counted with', () => {
    /** Whether a row carries the italic attribute, whatever else it is painted with. */
    const italic = (row: string): boolean =>
      [...row.matchAll(/\u001B\[([0-9;]*)m/g)].some(match => (match[1] ?? '').split(';').includes('3'))
    const painted = createTheme('256')
    const { state: clockState, clock } = clockAt(1_000)
    const model = new TranscriptModel(undefined, clock)
    model.apply({ type: 'tool/call', data: { name: 'run_code', arguments: '{"code":"x"}', callId: 'root' } })
    model.apply({
      type: 'tool/ptc-dispatch-start',
      data: { rootCallId: 'root', parentCallId: 'root', subCallId: 'root:ptc:1', name: 'bash', arguments: { command: 'echo hi' } },
    })
    model.apply({
      type: 'tool/ptc-dispatch',
      data: { rootCallId: 'root', parentCallId: 'root', subCallId: 'root:ptc:1', name: 'bash', arguments: { command: 'echo hi' }, isError: false, content: [] },
    })
    const inline: ViewState = { expandCards: false, expandReasoning: false, expandSubCalls: true }
    const view = new TranscriptView(model, painted, new MarkdownRenderer(painted.markdown), { state: () => inline })
    clockState.now += 10 * SECOND_MS
    const counting = view.render(60)[0] ?? ''
    expect(counting).toContain('~10s')
    // A moving measurement is stated plainly; the total that replaces it is what
    // the reader is meant to stop reading, so it is the one that slants.
    expect(italic(counting)).toBe(false)

    model.apply({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'root', text: 'done' }], isError: false } } })
    const settled = view.render(60)[0] ?? ''
    expect(settled).toContain('~10s')
    expect(italic(settled)).toBe(true)
  })

  it('draws no total on a program that answered when the reader turned the total off', () => {
    const { state: clockState, clock } = clockAt(1_000)
    const model = new TranscriptModel(undefined, clock)
    model.apply({ type: 'tool/call', data: { name: 'run_code', arguments: '{"code":"x"}', callId: 'root' } })
    model.apply({
      type: 'tool/ptc-dispatch-start',
      data: { rootCallId: 'root', parentCallId: 'root', subCallId: 'root:ptc:1', name: 'bash', arguments: { command: 'echo hi' } },
    })
    const inline: ViewState = { expandCards: false, expandReasoning: false, expandSubCalls: true }
    clockState.now += 10 * SECOND_MS
    model.apply({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'root', text: 'done' }], isError: false } } })
    const blind = createTheme('none', { palette: DEFAULT_PALETTE, tokens: new Map([['tool.elapsed.done', { hidden: true }]]) })
    const view = new TranscriptView(model, blind, new MarkdownRenderer(blind.markdown), { state: () => inline })
    // The counting timer and the kept total are separate elements, so a reader can
    // keep being told a call is in flight without being told how long it ran.
    expect(view.render(60)[0]).not.toContain('~')
  })

  it('draws no mark on a dispatched row when the reader has turned that mark off', () => {
    const { state: clockState, clock } = clockAt(1_000)
    const model = new TranscriptModel(bashPresenter, clock)
    model.apply({ type: 'tool/call', data: { name: 'run_code', arguments: '{"code":"x"}', callId: 'root' } })
    model.apply({
      type: 'tool/ptc-dispatch-start',
      data: { rootCallId: 'root', parentCallId: 'root', subCallId: 'root:ptc:1', name: 'bash', arguments: { command: 'echo hi' } },
    })
    const inline: ViewState = { expandCards: false, expandReasoning: false, expandSubCalls: true }
    const blind = createTheme('none', { palette: DEFAULT_PALETTE, tokens: new Map([['tool.subcall.running', { hidden: true }]]) })
    const view = new TranscriptView(model, blind, new MarkdownRenderer(blind.markdown), { state: () => inline })
    clockState.now += 2 * SECOND_MS
    expect(view.render(60).at(-1)).toBe('  bash echo hi')
  })

  it('draws no timer at all when the reader has turned the timer off', () => {
    const { clockState, model } = runningView()
    clockState.now += 5 * SECOND_MS
    const blind = createTheme('none', { palette: DEFAULT_PALETTE, tokens: new Map([['tool.running.elapsed', { hidden: true }]]) })
    const view = new TranscriptView(model, blind, new MarkdownRenderer(blind.markdown), { state: () => COLLAPSED })
    // Hiding the timer leaves the mark that introduced it, so the row still says
    // the call is in flight without reporting how long it has been.
    expect(view.render(60)).toEqual(['bash pnpm test'])
  })
})

describe('TranscriptView tool card clicks', () => {
  /** The shipped fold: one row per card, so a click has something to open. */
  const FOLDED: ViewState = { expandCards: false, expandReasoning: false, expandSubCalls: false }
  const EDIT_ARGS = '{"file_path":"/tmp/x","old_string":"b","new_string":"B"}'
  /** A presenter whose edit declares a diff, which is the card the reader clicks. */
  const editPresenter: ToolPresenter = {
    call: name => cardOfCall({ card: 'diff', title: 'Edit', diffs: [{ path: '/tmp/x', oldText: 'b', newText: 'B' }] }, name),
    result: (name, input) => (input.isError
      ? undefined
      : cardOfResult({ card: 'diff', diffs: [{ path: '/tmp/x', oldText: 'b', newText: 'B' }] }, { name, failed: false, contentLines: contentLines(input.content) })),
  }

  it('opens a clicked edit card to the diff it declared', () => {
    const model = new TranscriptModel(editPresenter)
    model.apply({ type: 'tool/call', data: { name: 'edit', arguments: EDIT_ARGS, callId: 'c1' } })
    model.apply(toolResult('updated'))
    const view = viewOf(model, FOLDED)
    expect(view.render(60)).toEqual(['edit /tmp/x  ~1'])
    view.handleMouse(mouse('click', 'left', 0))
    const opened = view.render(60).map(stripTerminalSequences)
    expect(opened).toContain('    /tmp/x  -1 +1')
    expect(opened).toContain('    -b')
    expect(opened).toContain('    +B')
    // Clicking the drawn diff folds the card back to its one row.
    view.handleMouse(mouse('click', 'left', 2))
    expect(view.render(60)).toEqual(['edit /tmp/x  ~1'])
  })

  it('opens a clicked failed card to the reason it failed', () => {
    const reason = 'Error: cannot modify "/tmp/x": file has not been read — read the file, then retry'
    const model = new TranscriptModel(editPresenter)
    model.apply({ type: 'tool/call', data: { name: 'edit', arguments: EDIT_ARGS, callId: 'c1' } })
    model.apply({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', text: reason }], isError: true } } })
    const view = viewOf(model, FOLDED)
    // Wide enough for the whole reason, because that is what a reader opens the
    // row to read: a narrow screen clips it like any other row.
    view.render(100)
    view.handleMouse(mouse('click', 'left', 0))
    expect(view.render(100).map(stripTerminalSequences)).toContain(`    ${reason}`)
  })
})
describe('TranscriptView copy', () => {
  /** The rows of a frame as the terminal hands a copy back: styling gone, trailing blanks gone. */
  const handedBack = (rows: readonly string[]): string => rows.map(row => stripTerminalSequences(row).trimEnd()).join('\n')

  it('reads a dragged copy back as the message, without the box it was drawn in', () => {
    const model = new TranscriptModel()
    model.apply({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'the answer' }] } } })
    const view = viewOf(model)
    const rows = view.render(40)
    // A drag over the box takes its sides with it; what the reader asked for is
    // what has to come back.
    expect(handedBack(rows)).toContain('│')
    expect(cleanCopied(handedBack(rows), view.copyRows())).toBe('the answer')
  })

  it('keeps two messages apart while dropping both of their frames', () => {
    const model = new TranscriptModel()
    model.apply({ type: 'user/message', data: { content: [{ type: 'text', text: 'ask' }], source: { kind: 'user' } } })
    model.apply({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'tell' }] } } })
    const view = viewOf(model)
    expect(cleanCopied(handedBack(view.render(40)), view.copyRows())).toBe('ask\ntell')
  })

  it('reads a reply that is still arriving back as its words', () => {
    const model = new TranscriptModel()
    model.applyStreamChunk({ type: 'text-delta', text: 'streaming reply' })
    const view = viewOf(model)
    const rows = view.render(40)
    // A live row is rebuilt every frame and has no entry to be kept under, so the
    // render itself has to answer for it.
    expect(handedBack(rows)).toContain('│')
    expect(cleanCopied(handedBack(rows), view.copyRows())).toBe('streaming reply')
  })

  it('keeps a live reply in the account beside a settled one', () => {
    const model = new TranscriptModel()
    model.apply({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'settled answer' }] } } })
    model.applyStreamChunk({ type: 'text-delta', text: 'streaming reply' })
    const view = viewOf(model)
    expect(cleanCopied(handedBack(view.render(40)), view.copyRows())).toBe('settled answer\nstreaming reply')
  })

  it('takes no word from another message when a drag ends on a box column', () => {
    const model = new TranscriptModel()
    model.apply({ type: 'user/message', data: { content: [{ type: 'text', text: 'alpha' }], source: { kind: 'user' } } })
    model.apply({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'beta' }] } } })
    const view = viewOf(model)
    const beta = handedBack(view.render(40)).split('\n').find(row => row.includes('beta')) ?? ''
    // The drag covered "beta" and then landed on the box's own column: the column is
    // the frame, so it goes, and nothing of the message above takes its place.
    expect(cleanCopied([beta, '│'].join('\n'), view.copyRows())).toBe('beta')
    // A copy of frame alone is handed back, not emptied, and not answered with a word.
    expect(cleanCopied('│', view.copyRows())).toBe('│')
  })

  it('takes nothing away from a row it never drew', () => {
    const model = new TranscriptModel()
    model.apply({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'the answer' }] } } })
    const view = viewOf(model)
    view.render(40)
    expect(cleanCopied('a row from the editor', view.copyRows())).toBe('a row from the editor')
  })
})

