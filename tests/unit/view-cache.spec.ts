/** Draft-only frames must preserve transcript output without rebuilding its document. */
import { describe, expect, it, vi } from 'vitest'
import { TranscriptModel } from '@/transcript.ts'
import { type GateCard } from '@/gates.ts'
import { MarkdownRenderer } from '@/ui/markdown.ts'
import { TranscriptView } from '@/ui/view.ts'
import { theme, viewOf } from './fixtures/transcript-view.ts'

const WIDTH = 60
const SECOND_MS = 1000

function assistant(text: string) {
  return { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }
}

describe('TranscriptView document reuse', () => {
  it('keeps unchanged settled and live output without visiting entries or formatting Markdown again', () => {
    const model = new TranscriptModel()
    model.apply(assistant('settled answer'))
    model.applyStreamChunk({ type: 'text-delta', text: '**live answer**' })
    const markdown = new MarkdownRenderer(theme.markdown)
    const view = new TranscriptView(model, theme, markdown)
    const first = view.render(WIDTH)
    const copied = view.copyRows()
    const entries = vi.spyOn(model, 'entries')
    const formatted = vi.spyOn(markdown, 'render')

    expect(view.render(WIDTH)).toEqual(first)
    expect(entries).not.toHaveBeenCalled()
    expect(formatted).not.toHaveBeenCalled()
    expect(view.copyRows()).toEqual(copied)
  })

  it('keeps an unchanged document through events the transcript does not display', () => {
    const model = new TranscriptModel()
    model.apply(assistant('stable answer'))
    const view = viewOf(model)
    const first = view.render(WIDTH)
    const entries = vi.spyOn(model, 'entries')

    model.apply({ type: 'session/heartbeat', data: {} })
    model.applyStreamChunk({ type: 'unknown-chunk' })

    expect(view.render(WIDTH)).toEqual(first)
    expect(entries).not.toHaveBeenCalled()
  })

  it('replaces live output as it settles and clears cached copy metadata on reset', () => {
    const model = new TranscriptModel()
    const view = viewOf(model)
    model.applyStreamChunk({ type: 'text-delta', text: 'before' })
    expect(view.render(WIDTH).join(' ')).toContain('before')
    model.applyStreamChunk({ type: 'text-delta', text: ' after' })
    expect(view.render(WIDTH).join(' ')).toContain('before after')
    model.apply(assistant('settled replacement'))
    const settled = view.render(WIDTH).join(' ')
    expect(settled).toContain('settled replacement')
    expect(settled).not.toContain('before after')
    model.notice('local notice')
    expect(view.render(WIDTH).join(' ')).toContain('local notice')
    model.reset()
    expect(view.render(WIDTH)).toEqual([])
    expect(view.copyRows()).toEqual([])
  })

  it('updates a reasoning clock without requiring a content event', () => {
    let now = 0
    const model = new TranscriptModel(undefined, () => now)
    model.applyStreamChunk({ type: 'reasoning-delta', text: 'thinking' })
    const view = viewOf(model)
    expect(view.render(WIDTH).join(' ')).toContain('1s')
    now += 2 * SECOND_MS
    expect(view.render(WIDTH).join(' ')).toContain('2s')
  })

  it('refreshes a mutable gate without appending it to the retained transcript', () => {
    const model = new TranscriptModel()
    model.apply(assistant('stable answer'))
    let gate: GateCard | undefined
    const view = new TranscriptView(model, theme, new MarkdownRenderer(theme.markdown), { gate: () => gate })
    const transcript = view.render(WIDTH)
    gate = {
      kind: 'approval', title: 'first approval', detail: [], options: [],
      optionOffset: 0, custom: undefined, answerInput: undefined, hint: '',
    }
    expect(view.render(WIDTH).join(' ')).toContain('first approval')
    gate = { ...gate, title: 'second approval' }
    const changed = view.render(WIDTH).join(' ')
    expect(changed).toContain('second approval')
    expect(changed).not.toContain('first approval')
    gate = undefined
    expect(view.render(WIDTH)).toEqual(transcript)
  })
})
