import { describe, expect, it } from 'vitest'
import { cardOfCall, cardOfResult, cardRow, contentLines, CARD_SHELL_PREVIEW, type ToolPresenter } from '@/cards.ts'
import type { GateCard } from '@/gates.ts'
import { createTheme, forwardEditorTheme, forwardMarkdownTheme, type TuiTheme } from '@/theme.ts'
import { DEFAULT_PALETTE } from '@/theme-tokens.ts'
import { TranscriptModel, type TranscriptEntry } from '@/transcript.ts'
import { MarkdownRenderer } from '@/ui/markdown.ts'
import type { PickerCard } from '@/ui/picker.ts'
import { RowCache } from '@/ui/rows.ts'
import { TranscriptView, type ViewState } from '@/ui/view.ts'

const theme = createTheme('none')
const COLLAPSED: ViewState = { expandCards: false, expandReasoning: false }

function viewOf(model: TranscriptModel, state: ViewState = COLLAPSED, gate?: GateCard): TranscriptView {
  return new TranscriptView(model, theme, new MarkdownRenderer(theme.markdown), { state: () => state, gate: () => gate })
}

const toolCall = (argumentsJson = '{}') => ({ type: 'tool/call', data: { name: 'bash', arguments: argumentsJson, callId: 'c1' } })
const toolResult = (text: string) => ({
  type: 'tool/result',
  data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', text }], isError: false } },
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
    const state = { expandCards: false, expandReasoning: false }
    const view = new TranscriptView(model, theme, new MarkdownRenderer(theme.markdown), { rows, state: () => state })

    view.render(80)
    expect(rows.stats().misses).toBe(1)
    view.render(40)
    expect(rows.stats().misses).toBe(2)
    state.expandCards = true
    view.render(40)
    expect(rows.stats().misses).toBe(3)
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

  it('keeps a human prompt on its own row', () => {
    const model = new TranscriptModel()
    model.apply({ type: 'user/message', data: { content: [{ type: 'text', text: 'hello there' }], source: { kind: 'user' } } })
    expect(viewOf(model).render(40)).toEqual(['hello there'])
  })

  it('escapes control sequences out of model and tool text', () => {
    // Any control sequence the presenter hands over has to be neutralized; the
    // row it lands on can be the header, which is what a folded card shows.
    const model = new TranscriptModel({
      call: () => ({ kind: 'generic', title: '\u001b[31mred\u0007', detail: [], failed: false, totalLines: 0 }),
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
    const folded = new TranscriptView(model, colour, markdown, { state: () => ({ expandCards: false, expandReasoning: false }) }).render(60)
    expect(folded).toEqual(expect.arrayContaining([expect.stringContaining('reasoning · 7 tokens')]))
    // The explicit grey, not a palette slot: this is the whole point.
    expect(folded[0]).toContain('\u001b[38;2;138;138;138m')
    expect(folded.some(line => line.includes('second thought'))).toBe(false)

    const opened = new TranscriptView(model, colour, markdown, { state: () => ({ expandCards: false, expandReasoning: true }) }).render(60)
    expect(opened).toHaveLength(4)
    for (const line of opened.slice(0, 3)) expect(line).toContain('\u001b[38;2;138;138;138m')
    expect(opened[3]).toBe('the answer')
  })

  it('wraps a long line to the width it was given', () => {
    const model = new TranscriptModel()
    model.apply({ type: 'user/message', data: { content: [{ type: 'text', text: 'x'.repeat(50) }], source: { kind: 'user' } } })
    const lines = viewOf(model).render(20)
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(20)
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
        { fallbackTitle: toolName, failed: input.isError, contentLines: contentLines(input.content) },
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
    const lines = viewOf(withRows(25), { expandCards: true, expandReasoning: false }).render(60)
    expect(lines.filter(line => line.startsWith('    row '))).toHaveLength(25)
    expect(lines.some(line => line.includes('ctrl+o'))).toBe(false)
  })

  it("keeps a shell card's output tail and names the rows it dropped", () => {
    const lines = viewOf(withRows(25, 'bash')).render(60)
    expect(lines[0]).toBe('Run echo rows')
    // The window is counted in rows, so the exit status shares it: 19 output
    // rows plus the pill make the last 20 the card keeps, and the 6 before them
    // are what the hint names.
    expect(lines.filter(line => line.startsWith('    row '))).toHaveLength(CARD_SHELL_PREVIEW - 1)
    expect(lines.some(line => line.startsWith('    row 4'))).toBe(false)
    expect(lines).toContain('    exit 0')
    expect(lines.at(-1)).toContain('… 6 earlier lines · ctrl+o')
  })

  it('shows a shell card whole once it is opened, and a short one without a hint', () => {
    const opened = viewOf(withRows(25, 'bash'), { expandCards: true, expandReasoning: false }).render(60)
    expect(opened.filter(line => line.startsWith('    row '))).toHaveLength(25)
    expect(opened.some(line => line.includes('earlier lines'))).toBe(false)
    const short = viewOf(withRows(3, 'bash')).render(60)
    expect(short.filter(line => line.startsWith('    row '))).toHaveLength(3)
    // The command, three output rows, and the exit status.
    expect(short).toHaveLength(5)
    expect(short.at(-1)).toBe('    exit 0')
  })

  it("keeps a failed shell card's tail and its failed title", () => {
    const failing: ToolPresenter = {
      call: () => ({ kind: 'terminal', title: 'Run rm', detail: [], failed: false, totalLines: 0 }),
      result: () => ({ kind: 'terminal', title: 'Run rm', detail: [cardRow('output', 'boom')], failed: true, totalLines: 1 }),
    }
    const model = new TranscriptModel(failing)
    model.apply({ type: 'tool/call', data: { name: 'bash', arguments: '{}', callId: 'c1' } })
    model.apply({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', text: 'boom' }], isError: true } } })
    const lines = viewOf(model).render(60)
    expect(lines[0]).toBe('Run rm')
    expect(lines).toContain('    boom')
  })

  it('names where the thought is when the row is folded', () => {
    let clock = 0
    const model = new TranscriptModel(undefined, () => clock)
    model.applyStreamChunk({ type: 'reasoning-delta', text: 'first thought\nsecond thought' })
    clock = 5_000
    model.applyStreamChunk({ type: 'block-end', block: { type: 'reasoning' } })
    const folded = viewOf(model).render(60)
    // The row must say the body exists: a count with no way to reach the text
    // reads the same as the text never having arrived.
    expect(folded).toEqual([
      'reasoning · 7 tokens · 5s',
      '    ctrl+t shows it',
    ])
    const opened = viewOf(model, { expandCards: false, expandReasoning: true }).render(60)
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
      options: [],
      hint: 'y allow once · n reject · esc cancel',
    }
    const lines = viewOf(new TranscriptModel(), COLLAPSED, gate).render(60)
    expect(lines).toContain('⚠ approval needed · bash')
    expect(lines.some(line => line.includes('write outside the workspace'))).toBe(true)
    expect(lines.some(line => line.includes('y allow once'))).toBe(true)
  })

  it('renders question options with their cursor and selection', () => {
    const gate: GateCard = {
      kind: 'question',
      title: 'which target?  (1/2)',
      detail: [],
      options: [
        { label: 'staging', description: 'safe', current: true, selected: true },
        { label: 'production', description: undefined, current: false, selected: false },
      ],
      hint: 'space select · digits pick · enter confirm · esc skip',
    }
    const lines = viewOf(new TranscriptModel(), COLLAPSED, gate).render(60)
    expect(lines).toContain('? which target?  (1/2)')
    expect(lines).toContain('   ❯ [x] 1. staging — safe')
    expect(lines).toContain('     [ ] 2. production')
  })
})

describe('TranscriptView theming', () => {
  const userModel = (): TranscriptModel => {
    const model = new TranscriptModel()
    model.apply({ type: 'user/message', data: { content: [{ type: 'text', text: 'hello there' }], source: { kind: 'user' } } })
    return model
  }

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
      state: () => ({ expandCards: false, expandReasoning: true }),
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
    const view = new TranscriptView(userModel(), delegate, new MarkdownRenderer(delegate.markdown), { state: () => COLLAPSED })
    expect(view.render(60).join('\n')).toContain('38;2;208;208;208')
    active = createTheme('truecolor', { palette: DEFAULT_PALETTE, tokens: new Map([['transcript.user', { fg: '#ff0000' }]]) })
    // The row cache is keyed to the old revision, so a plain repaint re-draws it.
    expect(view.render(60).join('\n')).toContain('38;2;255;0;0')
  })
})
