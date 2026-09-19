import { CURSOR_MARKER, type TUI, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { createTheme } from '@/theme.ts'
import { GateInputBar } from '@/ui/gate-input.ts'

/** The terminal the bar renders against; these tests read its rows only. */
const STUB_TUI = { requestRender: () => {}, terminal: { rows: 24, cols: 80 } } as unknown as TUI

/** The bar the surface answers questions in, which is the prompt bar's component. */
const answerBar = (): GateInputBar => new GateInputBar(STUB_TUI, createTheme('none').editor)

const drawn = (bar: GateInputBar, width = 40): string => bar.render(width).join('\n')

describe('GateInputBar', () => {
  it('shows the answer it holds', () => {
    const bar = answerBar()
    bar.setText('release/0.2')
    expect(drawn(bar)).toContain('release/0.2')
  })

  it('hides every character of a secret while still holding all of them', () => {
    const bar = answerBar()
    bar.setMode('secret')
    bar.setText('sk-ant-api03-FAKE9988')
    expect(bar.getExpandedText()).toBe('sk-ant-api03-FAKE9988')
    expect(drawn(bar)).not.toContain('FAKE9988')
    expect(drawn(bar)).toMatch(/\*{5,}/u)
  })

  it('masks to the width of what it hides, so the frame cannot move', () => {
    const bar = answerBar()
    bar.setMode('secret')
    // Wide characters take two columns each, and a mask narrower than the text
    // would pull the right edge of the frame inward as the answer grows.
    bar.setText('\u65e5\u672c\u8a9e\u306e\u30ad\u30fc')
    expect(drawn(bar)).toContain('*'.repeat(12))
    expect(bar.render(40).every(row => visibleWidth(row) === 40)).toBe(true)
  })

  it('keeps the cursor marker, which is how the terminal is told where the cursor is', () => {
    const bar = answerBar()
    bar.focused = true
    bar.setMode('secret')
    bar.setText('sk-ant-api03-FAKE9988')
    expect(drawn(bar)).toContain(CURSOR_MARKER)
  })

  it('shows a secret again once the question that hid it is left behind', () => {
    const bar = answerBar()
    bar.setMode('secret')
    bar.setText('sk-ant-api03-FAKE9988')
    bar.setMode('answer')
    expect(drawn(bar)).toContain('sk-ant-api03-FAKE9988')
  })
})
