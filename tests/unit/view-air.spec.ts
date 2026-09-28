/**
 * The air the transcript keeps: around a framed message, and where a step of a
 * turn opens, so a thought and the calls it made read as one group.
 */

import { describe, expect, it } from 'vitest'
import { TranscriptModel } from '@/transcript.ts'
import { MarkdownRenderer } from '@/ui/markdown.ts'
import { TranscriptView } from '@/ui/view.ts'
import { type Spacing } from '@/spacing.ts'
import { theme, COLLAPSED } from './fixtures/transcript-view.ts'

/** The rows as what they are, so a shape can be read in one line. */
function shape(lines: readonly string[]): string[] {
  return lines.map(line => line === ''
    ? 'air'
    // A frame draws its own sides and its own foot, and all of them are the box.
    : line.startsWith('╭') || line.startsWith('│') || line.startsWith('╰') ? 'box'
      : line.startsWith('reasoning') ? 'thought'
        : line.startsWith('bash') ? 'call' : 'other')
}

function viewOf(model: TranscriptModel, spacing: () => Spacing): TranscriptView {
  return new TranscriptView(model, theme, new MarkdownRenderer(theme.markdown), { state: () => COLLAPSED, spacing })
}

/** The shipped spacing, stated here so a change to it lands in this spec's face. */
const SHIPPED: Spacing = { padding: 1, messages: 1, steps: 1 }

/** A prompt, then a step that thinks and calls, then the step that answers. */
function stepped(): TranscriptModel {
  const model = new TranscriptModel()
  model.apply({ type: 'user/message', data: { content: [{ type: 'text', text: 'ask' }], source: { kind: 'user' } } })
  model.apply({ type: 'step/start', data: { turn: 1, step: 1 } })
  model.apply({ type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'first thought' }] } } })
  model.apply({ type: 'tool/call', data: { name: 'bash', arguments: '{"command":"pnpm test"}', callId: 'c1' } })
  model.apply({ type: 'step/start', data: { turn: 1, step: 2 } })
  model.apply({ type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'second thought' }] } } })
  model.apply({ type: 'tool/call', data: { name: 'bash', arguments: '{"command":"pnpm test"}', callId: 'c2' } })
  model.apply({ type: 'step/start', data: { turn: 1, step: 3 } })
  model.apply({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'the answer' }] } } })
  return model
}

describe('TranscriptView air', () => {
  it('opens and closes a framed message with one row, however many asked for it', () => {
    const model = new TranscriptModel()
    model.apply({ type: 'user/message', data: { content: [{ type: 'text', text: 'ask' }], source: { kind: 'user' } } })
    model.apply({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'tell' }] } } })
    // The prompt's closing row and the reply's opening row are one break, not two:
    // what the reader asked for is air between two things, not one per thing.
    expect(shape(viewOf(model, () => SHIPPED).render(40))).toEqual(['air', 'box', 'box', 'box', 'air', 'box', 'box', 'box', 'air'])
  })

  it('opens a step with air, so a thought and the calls it made stay one group', () => {
    expect(shape(viewOf(stepped(), () => SHIPPED).render(40))).toEqual([
      'air', 'box', 'box', 'box',
      'air', 'thought', 'call',
      'air', 'thought', 'call',
      'air', 'box', 'box', 'box', 'air',
    ])
  })

  it('keeps a step apart when it is a step of calls and nothing else', () => {
    const model = new TranscriptModel()
    model.apply({ type: 'step/start', data: { turn: 1, step: 1 } })
    model.apply({ type: 'tool/call', data: { name: 'bash', arguments: '{}', callId: 'c1' } })
    model.apply({ type: 'step/start', data: { turn: 1, step: 2 } })
    model.apply({ type: 'tool/call', data: { name: 'bash', arguments: '{}', callId: 'c2' } })
    // Read off the loop's own event rather than guessed from the rows, which is the
    // one thing a step that says nothing at all would give away.
    expect(shape(viewOf(model, () => SHIPPED).render(40))).toEqual(['air', 'call', 'air', 'call'])
  })

  it('draws the rows dense when the reader asks for no air at all', () => {
    const none: Spacing = { padding: 0, messages: 0, steps: 0 }
    const rows = viewOf(stepped(), () => none).render(40)
    expect(rows.every(row => row !== '')).toBe(true)
    expect(shape(rows)).toEqual(['box', 'box', 'box', 'thought', 'call', 'thought', 'call', 'box', 'box', 'box'])
  })

  it('redraws the rows it cached when the reader moves the air', () => {
    let spacing: Spacing = { padding: 1, messages: 0, steps: 0 }
    const view = viewOf(stepped(), () => spacing)
    expect(view.render(40).every(row => row !== '')).toBe(true)
    // The rows of a cached entry hold the air it was drawn with, so the counts are
    // part of the key: an edit to the document has to reach the rows already drawn.
    spacing = SHIPPED
    expect(shape(view.render(40))).toEqual([
      'air', 'box', 'box', 'box',
      'air', 'thought', 'call',
      'air', 'thought', 'call',
      'air', 'box', 'box', 'box', 'air',
    ])
  })
})
