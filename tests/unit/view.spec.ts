import { describe, expect, it } from 'vitest'
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { cardOfCall, cardOfResult, contentLines, CARD_DETAIL_MAX, CARD_SHELL_PREVIEW, type ToolPresenter } from '@/cards.ts'
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

  it("keeps a shell card's command and output tail and names the rows it dropped", () => {
    const lines = viewOf(withRows(25, 'bash')).render(60)
    // The tool label and the command sit outside the fold, so the preview is
    // free to spend its whole window on output and still report how it ended.
    expect(lines[0]).toBe('bash')
    expect(lines[1]).toBe('    Run echo rows')
    expect(lines.filter(line => line.startsWith('    row '))).toHaveLength(CARD_SHELL_PREVIEW)
    expect(lines.some(line => line.startsWith('    row 4'))).toBe(false)
    expect(lines).toContain('    exit 0')
    expect(lines.at(-1)).toContain('… 5 earlier lines · ctrl+o')
  })

  it('shows a shell card whole once it is opened, and a short one without a hint', () => {
    const opened = viewOf(withRows(25, 'bash'), { expandCards: true, expandReasoning: false }).render(60)
    expect(opened[0]).toBe('bash')
    expect(opened[1]).toBe('    Run echo rows')
    expect(opened.filter(line => line.startsWith('    row '))).toHaveLength(25)
    expect(opened.some(line => line.includes('earlier lines'))).toBe(false)
    const short = viewOf(withRows(3, 'bash')).render(60)
    expect(short.filter(line => line.startsWith('    row '))).toHaveLength(3)
    // The label, the command, three output rows, and the exit status.
    expect(short).toHaveLength(6)
    expect(short.at(-1)).toBe('    exit 0')
  })

  it("names an opened shell card's dropped rows as the earlier ones", () => {
    // Retention keeps the tail, so opening a run past the cap reveals its end
    // and hides its beginning; a neutral count would point the reader past the
    // last row on screen for rows that are above it.
    const opened = viewOf(withRows(250, 'bash'), { expandCards: true, expandReasoning: false }).render(60)
    expect(opened.filter(line => line.startsWith('    row '))).toHaveLength(CARD_DETAIL_MAX)
    expect(opened).toContain('    exit 0')
    expect(opened.at(-1)).toBe('    … 50 earlier lines not shown')
  })

  it("keeps a failed shell card's command, tail, and failed title", () => {
    // Built through the real card mappers so the assertion covers the shell
    // shape a failing command actually produces, not a hand-made card.
    const failing: ToolPresenter = {
      call: name => cardOfCall({ card: 'terminal', title: 'rm -rf /tmp/x' }, name),
      result: (name, input) => cardOfResult(
        { card: 'terminal', output: 'boom', exitCode: 1 },
        { fallbackTitle: name, failed: input.isError, contentLines: contentLines(input.content) },
      ),
    }
    const model = new TranscriptModel(failing)
    model.apply({ type: 'tool/call', data: { name: 'bash', arguments: '{}', callId: 'c1' } })
    model.apply({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', text: 'boom' }], isError: true } } })
    const lines = viewOf(model).render(60)
    expect(lines[0]).toBe('bash')
    expect(lines[1]).toBe('    rm -rf /tmp/x')
    expect(lines).toContain('    boom')
    expect(lines).toContain('    exit 1')
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

describe('TranscriptView tool args and stats', () => {
  /** Fold one call and result through a presenter, so the merge is what renders. */
  const folded = (name: string, presenter: ToolPresenter, width = 80): string[] => {
    const model = new TranscriptModel(presenter)
    model.apply({ type: 'tool/call', data: { name, arguments: '{}', callId: 'c1' } })
    model.apply({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', text: 'body' }], isError: false } } })
    return viewOf(model).render(width)
  }

  it('shows a read path with its range, size, and tokens on the folded line', () => {
    const presenter: ToolPresenter = {
      call: name => cardOfCall({ card: 'generic', title: 'Read a.ts (from line 5)', kind: 'read', locations: [{ path: 'a.ts', line: 5 }] }, name),
      result: (name, input) => cardOfResult(
        { card: 'read', path: 'a.ts', offset: 5, lines: [{ number: 5, text: 'x' }, { number: 6, text: 'y' }], totalLines: 20 },
        { fallbackTitle: name, failed: input.isError, contentLines: contentLines(input.content) },
      ),
    }
    expect(folded('read', presenter)).toEqual(['read a.ts  L5–6 · 2 lines · 1 tok'])
  })

  it('shows a new file by its line and token size', () => {
    const presenter: ToolPresenter = {
      call: name => cardOfCall({ card: 'diff', title: 'Write a.txt', diffs: [{ path: 'a.txt', oldText: null, newText: 'one\ntwo\nthree' }] }, name),
      result: (name, input) => cardOfResult(
        { card: 'diff', diffs: [{ path: 'a.txt', oldText: null, newText: 'one\ntwo\nthree' }] },
        { fallbackTitle: name, failed: input.isError, contentLines: contentLines(input.content) },
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
        { fallbackTitle: name, failed: input.isError, contentLines: contentLines(input.content) },
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
        { fallbackTitle: name, failed: input.isError, contentLines: contentLines(input.content) },
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
        { fallbackTitle: name, failed: input.isError, contentLines: contentLines(input.content) },
      ),
    }
    const lines = folded('bash', presenter, 40)
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
        { fallbackTitle: name, failed: input.isError, contentLines: contentLines(input.content) },
      ),
    }
    const lines = folded('read', presenter, 40)
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
        { fallbackTitle: name, failed: input.isError, contentLines: contentLines(input.content) },
      ),
    }
    const colour = createTheme('truecolor')
    const model = new TranscriptModel(presenter)
    model.apply({ type: 'tool/call', data: { name: 'bash', arguments: '{}', callId: 'c1' } })
    model.apply({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', text: 'ok' }], isError: false } } })
    const lines = new TranscriptView(model, colour, new MarkdownRenderer(colour.markdown), { state: () => COLLAPSED }).render(40)
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40)
    expect(stripTerminalSequences(lines.join('')).replace(/\s+/gu, '')).toContain(command.replace(/\s+/gu, ''))
  })
})
