import { describe, expect, it } from 'vitest'
import { stripTerminalSequences, type TUI, type TuiMouseEvent, visibleWidth } from '@earendil-works/pi-tui'
import { cardOfCall, cardOfResult, contentLines, CARD_DETAIL_MAX, CARD_SHELL_PREVIEW, SUBCALL_MAX, type ToolPresenter } from '@/cards.ts'
import type { GateCard } from '@/gates.ts'
import { createTheme, forwardEditorTheme, forwardMarkdownTheme, type TuiTheme } from '@/theme.ts'
import { DEFAULT_PALETTE } from '@/theme-tokens.ts'
import { TranscriptModel, type TranscriptEntry } from '@/transcript.ts'
import { MarkdownRenderer } from '@/ui/markdown.ts'
import type { PickerCard } from '@/ui/picker.ts'
import { RowCache } from '@/ui/rows.ts'
import { BoxedEditor } from '@/ui/editor.ts'
import { TranscriptView, type ViewState } from '@/ui/view.ts'
import { DEFAULT_TOOL_DISPLAY, toolDisplayFor, toolDisplayTable, type ToolDisplayTable } from '@/tool-display.ts'

const theme = createTheme('none')

/** The terminal the bar under test renders against; these tests read its rows only. */
const STUB_TUI = { requestRender: () => {}, terminal: { rows: 24, cols: 80 } } as unknown as TUI

/** The editor a gate answers in, which is the surface's own prompt bar. */
const answerBar = (text: string): BoxedEditor => {
  const bar = new BoxedEditor(STUB_TUI, theme.editor)
  bar.setText(text)
  return bar
}
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
    expect(rows.stats()).toEqual({ hits: 0, misses: 2, size: 2 })
    expect(view.render(80)).toEqual(first)
    expect(rows.stats()).toEqual({ hits: 2, misses: 2, size: 2 })
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
})

describe('TranscriptView text', () => {
  it('renders assistant text as markdown', () => {
    const model = new TranscriptModel()
    model.apply({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '# Title\n\nplain **strong**' }] } } })
    const lines = viewOf(model).render(60)
    expect(lines[0]).toBe('Title')
    expect(lines.some(line => line.includes('strong'))).toBe(true)
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

  it('leaves a surface notice outside the frame', () => {
    const model = new TranscriptModel()
    model.notice('compacted 12 events')
    expect(viewOf(model).render(40)).toEqual(['compacted 12 events'])
  })

  it('escapes control sequences out of model and tool text', () => {
    // Any control sequence the presenter hands over has to be neutralized; the
    // row it lands on can be the header, which is what a folded card shows.
    const model = new TranscriptModel({
      call: () => ({ kind: 'generic', tool: 'bash', title: '\u001b[31mred\u0007', detail: [], failed: false, totalLines: 0 }),
      result: () => undefined,
    })
    model.apply(toolCall())
    model.apply(toolResult('plain'))
    const lines = viewOf(model).render(60)
    const rendered = lines.join('\n')
    expect(rendered).toContain('\\x1B[31mred\\x07')
    expect(rendered).not.toContain('\u001b')
  })

  it('renders a recorded thought, folded or open, dimmed, and leaves the answer alone', () => {
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
    expect(folded[0]).toContain('\u001b[3;38;2;117;117;117m')
    expect(folded[0]).not.toContain('\u001b[38;2;138;138;138m')
    expect(folded.some(line => line.includes('second thought'))).toBe(false)

    const opened = new TranscriptView(model, colour, markdown, { state: () => ({ expandCards: false, expandReasoning: true, expandSubCalls: false }) }).render(60)
    expect(opened).toHaveLength(4)
    expect(opened[0]).toContain('\u001b[3;38;2;117;117;117m')
    // The explicit grey, not a palette slot: this is the whole point.
    for (const line of opened.slice(1, 3)) expect(line).toContain('\u001b[38;2;138;138;138m')
    expect(opened[3]).toBe('the answer')
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
    expect(opened[0]).toContain('\u001b[3;38;2;117;117;117m')
    for (const line of opened.slice(1, -1).filter(line => line !== '')) {
      expect(line).toContain('\u001b[38;2;138;138;138m')
    }
    expect(opened.at(-1)).toBe('the answer')
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

  it('shows the output a clicked shell card kept', () => {
    const view = viewOf(withRows(3, 'bash'))
    expect(view.render(60)).toEqual(['bash Run echo rows · exit 0 · 3 lines'])
    // A click opens the one card and reveals what the command printed.
    view.handleMouse(mouse('click', 'left', 0))
    const opened = view.render(60)
    expect(opened.filter(line => line.startsWith('    row '))).toHaveLength(3)
    expect(opened).toContain('    exit 0')
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
      hint: '↑↓ move · enter open · esc cancel · type to filter',
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

  it('wraps the reason a pick was refused under the heading', () => {
    const picker: PickerCard = {
      title: 'resume a session · 1 stored',
      note: 'session tui-session-a runs mode "cordis", so --preset standard does not apply; /preset standard switches it before its first turn',
      rows: [{ label: 'tui-session-a', description: '/work · 3m ago', current: true }],
      filter: '',
      hint: '↑↓ move · enter open · esc cancel · type to filter',
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
      hint: 'type or paste an answer · enter confirm · ↑↓ or esc back to options',
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

  it('rebuilds cached rows when the theme revision moves', () => {
    let active = createTheme('truecolor')
    const delegate: TuiTheme = {
      get revision() { return active.revision },
      get color() { return active.color },
      style: (token, text) => active.style(token, text),
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
      return cardOfCall({ card: 'generic', title: 'Read', kind: 'read', locations: [{ path: String(args.file_path ?? '') }] }, name)
    },
    result: (name, input) => name === 'bash'
      ? cardOfResult(
          { card: 'terminal', output: contentLines(input.content).join('\n'), exitCode: 0 },
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
    expect(lines.slice(1)).toEqual(['  read src/x.ts', '  bash git status'])
  })

  it('draws each call on one two-space-indented line under the header', () => {
    const model = foldedProgram([
      { name: 'read', args: { file_path: 'src/x.ts' } },
      { name: 'bash', args: { command: 'git status' } },
    ])
    expect(viewOf(model, INLINE).render(60)).toEqual(['search the tree', '  read src/x.ts', '  bash git status', '    done'])
  })

  it('marks a failed call in the failed colour without hiding it', () => {
    const colour = createTheme('truecolor')
    const model = foldedProgram([{ name: 'bash', args: { command: 'exit 1' }, failed: true }])
    const lines = new TranscriptView(model, colour, new MarkdownRenderer(colour.markdown), { state: () => INLINE }).render(60)
    expect(stripTerminalSequences(lines[1] ?? '')).toBe('  bash exit 1')
    // Derived rather than repeated: this is about the failure colour, not a shade.
    const removed = [1, 3, 5].map(at => Number.parseInt(DEFAULT_PALETTE.removed.slice(at, at + 2), 16))
    expect(lines[1]).toContain(`38;2;${removed.join(';')}`)
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
    expect(view.render(60)).toEqual(['search the tree', '  bash echo hi', '  read src/y.ts'])
    // The output is the reason to open the row, and only the clicked call gets it.
    view.handleMouse(mouse('click', 'left', 1))
    expect(view.render(60)).toEqual(['search the tree', '  bash echo hi', '    hi', '    there', '  read src/y.ts'])
    // A click anywhere on the opened call closes it, output and all.
    view.handleMouse(mouse('click', 'left', 2))
    expect(view.render(60)).toEqual(['search the tree', '  bash echo hi', '  read src/y.ts'])
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
    expect(opened.slice(1, -1).join('').split('x')).toHaveLength(81)
    expect(opened.join('')).not.toContain('done')
    for (const line of opened) expect(visibleWidth(line)).toBeLessThanOrEqual(40)
    // Clicking the opened call folds it back to the one line it started as.
    view.handleMouse(mouse('click', 'left', 1))
    expect(view.render(40)).toEqual(folded)
  })
})
