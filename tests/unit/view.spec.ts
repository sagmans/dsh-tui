import { describe, expect, it } from 'vitest'
import type { GateCard } from '@/gates.ts'
import { createTheme } from '@/theme.ts'
import { TranscriptModel, type TranscriptEntry } from '@/transcript.ts'
import { MarkdownRenderer } from '@/ui/markdown.ts'
import type { PickerCard } from '@/ui/picker.ts'
import { RowCache } from '@/ui/rows.ts'
import { TranscriptView, REASONING_VIEW_ORDER, nextReasoningView, type ViewState } from '@/ui/view.ts'

const theme = createTheme(false)
const COLLAPSED: ViewState = { expandCards: false, reasoning: 'summary' }

function viewOf(model: TranscriptModel, state: ViewState = COLLAPSED, gate?: GateCard): TranscriptView {
  return new TranscriptView(model, theme, new MarkdownRenderer(theme.markdown), { state: () => state, gate: () => gate })
}

/** One settled reasoning block, with a clock that only moves when the fixture says so. */
function reasoningModel(): TranscriptModel {
  let clock = 0
  const model = new TranscriptModel(undefined, () => clock)
  model.applyStreamChunk({ type: 'reasoning-delta', text: 'first thought\nsecond thought' })
  clock = 5_000
  model.applyStreamChunk({ type: 'block-end', block: { type: 'reasoning' } })
  return model
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
    const state: { expandCards: boolean; reasoning: ViewState['reasoning'] } = { expandCards: false, reasoning: 'summary' }
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
  it('renders assistant text as markdown under its glyph', () => {
    const model = new TranscriptModel()
    model.apply({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '# Title\n\nplain **strong**' }] } } })
    const lines = viewOf(model).render(60)
    expect(lines[0]).toBe('⏺ Title')
    expect(lines.some(line => line.includes('strong'))).toBe(true)
  })

  it('keeps a human prompt on its own glyph', () => {
    const model = new TranscriptModel()
    model.apply({ type: 'user/message', data: { content: [{ type: 'text', text: 'hello there' }], source: { kind: 'user' } } })
    expect(viewOf(model).render(40)).toEqual(['› hello there'])
  })

  it('escapes control sequences out of model and tool text', () => {
    const model = new TranscriptModel()
    model.apply(toolCall())
    model.apply(toolResult('\u001b[31mred\u0007'))
    const lines = viewOf(model).render(60)
    const rendered = lines.join('\n')
    expect(rendered).toContain('\\x1B[31mred\\x07')
    expect(rendered).not.toContain('\u001b')
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
    expect(viewOf(model).render(60)).toEqual(['⧉ compacted 12 events (≈3000 tokens)'])
  })
})

describe('TranscriptView expansion', () => {
  const withRows = (rows: number): TranscriptModel => {
    const model = new TranscriptModel()
    model.apply(toolCall())
    model.apply(toolResult(Array.from({ length: rows }, (_, index) => `row ${index}`).join('\n')))
    return model
  }

  it('previews a long card and says how to open it', () => {
    const lines = viewOf(withRows(25)).render(60)
    expect(lines.filter(line => line.startsWith('    row '))).toHaveLength(10)
    expect(lines.at(-1)).toContain('ctrl+o')
  })

  it('shows every retained row once cards are expanded', () => {
    const lines = viewOf(withRows(25), { expandCards: true, reasoning: 'summary' }).render(60)
    expect(lines.filter(line => line.startsWith('    row '))).toHaveLength(25)
    expect(lines.some(line => line.includes('ctrl+o'))).toBe(false)
  })

  it('keeps reasoning folded until it is asked for', () => {
    const lines = viewOf(reasoningModel()).render(60)
    expect(lines).toEqual(['▸ reasoning · 2 lines · 28 chars · 5s'])
  })

  it('shows the thought itself only once reasoning is expanded', () => {
    const lines = viewOf(reasoningModel(), { expandCards: false, reasoning: 'expanded' }).render(60)
    expect(lines).toEqual([
      '▸ reasoning · 2 lines · 28 chars · 5s',
      '    first thought',
      '    second thought',
    ])
  })

  it('leaves no row at all once reasoning is hidden, so the answer still reads as the only reply', () => {
    const model = reasoningModel()
    model.apply({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'the answer' }] } } })
    const lines = viewOf(model, { expandCards: false, reasoning: 'hidden' }).render(60)
    expect(lines.some(line => line.includes('reasoning'))).toBe(false)
    expect(lines.some(line => line.includes('first thought'))).toBe(false)
    expect(lines.some(line => line.includes('the answer'))).toBe(true)
  })

  it('leaves no row for a thought that is still streaming', () => {
    const model = new TranscriptModel(undefined, () => 1_000)
    model.applyStreamChunk({ type: 'reasoning-delta', text: 'mid-thought' })
    expect(viewOf(model, { expandCards: false, reasoning: 'hidden' }).render(60)).toEqual([])
  })

  it('marks reasoning with styling the answer does not carry', () => {
    const styled = createTheme(true)
    const model = reasoningModel()
    model.apply({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'the answer' }] } } })
    const view = new TranscriptView(model, styled, new MarkdownRenderer(styled.markdown), {
      state: () => ({ expandCards: false, reasoning: 'expanded' } satisfies ViewState),
    })
    const lines = view.render(60)
    const thought = lines.filter(line => /reasoning|thought/.test(line))
    const answer = lines.filter(line => line.includes('the answer'))
    expect(thought).toHaveLength(3)
    expect(answer).toHaveLength(1)
    for (const line of thought) expect(line).toContain('\u001b[2;90m')
    expect(answer[0]).not.toContain('\u001b[')
  })
})

describe('nextReasoningView', () => {
  it('walks summary, then the thought itself, then nothing, and back', () => {
    expect(REASONING_VIEW_ORDER).toEqual(['summary', 'expanded', 'hidden'])
    expect(nextReasoningView('summary')).toBe('expanded')
    expect(nextReasoningView('expanded')).toBe('hidden')
    expect(nextReasoningView('hidden')).toBe('summary')
  })

  it('settles on the default rather than throwing for a state it cannot place', () => {
    expect(nextReasoningView('nonsense' as ViewState['reasoning'])).toBe('summary')
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
    expect(lines).toContain('↻ resume a session · 2 stored')
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
    const heading = lines.findIndex(line => line.includes('↻ resume a session'))
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
