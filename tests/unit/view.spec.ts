import { describe, expect, it } from 'vitest'
import type { GateCard } from '@/gates.ts'
import { createTheme } from '@/theme.ts'
import { TranscriptModel, type TranscriptEntry } from '@/transcript.ts'
import { MarkdownRenderer } from '@/ui/markdown.ts'
import type { PickerCard } from '@/ui/picker.ts'
import { RowCache } from '@/ui/rows.ts'
import { TranscriptView, type ViewState } from '@/ui/view.ts'

const theme = createTheme(false)
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
    const lines = viewOf(withRows(25), { expandCards: true, expandReasoning: false }).render(60)
    expect(lines.filter(line => line.startsWith('    row '))).toHaveLength(25)
    expect(lines.some(line => line.includes('ctrl+o'))).toBe(false)
  })

  it('keeps reasoning folded until it is asked for', () => {
    let clock = 0
    const model = new TranscriptModel(undefined, () => clock)
    model.applyStreamChunk({ type: 'reasoning-delta', text: 'first thought\nsecond thought' })
    clock = 5_000
    model.applyStreamChunk({ type: 'block-end', block: { type: 'reasoning' } })
    const folded = viewOf(model).render(60)
    expect(folded).toEqual(['▸ reasoning · 2 lines · 28 chars · 5s'])
    const opened = viewOf(model, { expandCards: false, expandReasoning: true }).render(60)
    expect(opened).toEqual([
      '▸ reasoning · 2 lines · 28 chars · 5s',
      '    first thought',
      '    second thought',
    ])
  })
})

describe('TranscriptView picker', () => {
  it('lists stored sessions with a cursor, a filter, and the keys that drive it', () => {
    const picker: PickerCard = {
      title: 'resume a session · 2 stored',
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
