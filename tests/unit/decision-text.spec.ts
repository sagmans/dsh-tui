/** Decision text must retain evidence of controls rather than repaint the action being inspected. */
import { describe, expect, it } from 'vitest'
import { ApprovalGate } from '@/gates.ts'
import { defaultKeymap } from '@/input/actions.ts'
import { createTheme } from '@/theme.ts'
import { TranscriptModel } from '@/transcript.ts'
import { MarkdownRenderer } from '@/ui/markdown.ts'
import { TranscriptView } from '@/ui/view.ts'

const WIDTH = 120
const COMMAND = 'printf EXECUTED #\rprintf DISPLAY_ONLY'
const REASON = 'write protected target\rread project configuration'
const BACKSPACE_REASON = 'delete protected target\bread configuration'
const theme = createTheme('none')

describe('decision text', () => {
  it.each([REASON, BACKSPACE_REASON])('preserves literal approval evidence without changing the decision', reason => {
    const gate = new ApprovalGate('bash', reason, defaultKeymap)
    const view = new TranscriptView(new TranscriptModel(), theme, new MarkdownRenderer(theme.markdown), { gate: () => gate.card() })
    const rendered = view.render(WIDTH).join('\n')
    expect(rendered).toContain(reason.startsWith('write') ? 'write protected target\\x0D' : 'delete protected target\\x08')
    expect(gate.handleKey('y')).toBe('allowed-once')
  })

  it('preserves the command prefix in an expanded terminal card', () => {
    const model = new TranscriptModel({
      call: () => ({ kind: 'terminal', tool: 'bash', title: 'bash', argument: COMMAND, detail: [], failed: false, totalLines: 0 }),
      result: () => undefined,
    })
    model.apply({ type: 'tool/call', data: { name: 'bash', arguments: '{}', callId: 'decision-command' } })
    const view = new TranscriptView(model, theme, new MarkdownRenderer(theme.markdown), {
      state: () => ({ expandCards: true, expandReasoning: false, expandSubCalls: false }),
    })
    expect(view.render(WIDTH).join('\n')).toContain('printf EXECUTED #\\x0Dprintf DISPLAY_ONLY')
  })
})
