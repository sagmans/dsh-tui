import { describe, expect, it } from 'vitest'
import type { Component, TUI, TuiMouseEvent } from '@earendil-works/pi-tui'
import { getLayoutBoxesAt, renderLayoutFrame } from '@earendil-works/pi-tui/dist/layout.js'
import { dispatchMouseEvent } from '@earendil-works/pi-tui/dist/tui.js'
import { createTheme } from '@/theme.ts'
import { BoxedEditor } from '@/ui/editor.ts'
import { PROMPT_MIN_ROWS, surfaceLayout } from '@/ui/layout.ts'
import { PromptBar } from '@/ui/prompt.ts'

/** The surface only ever lends the editor its terminal size and a repaint. */
const STUB_TUI = { requestRender: () => {}, terminal: { rows: 24, columns: 80 } } as unknown as TUI

/** A leaf of known height, standing in for a component this policy does not test. */
const rowsOf = (text: string, count: number): Component => ({
  render: () => Array.from({ length: count }, (_, at) => `${text} ${at}`),
  invalidate: () => {},
})

function promptOf(text: string): { prompt: PromptBar; editor: BoxedEditor } {
  const editor = new BoxedEditor(STUB_TUI, createTheme('none').editor)
  editor.setText(text)
  return { prompt: new PromptBar(editor), editor }
}

describe('the surface root layout', () => {
  it('keeps the draft and the footer when the dock wants more rows than the terminal has', () => {
    const { prompt } = promptOf('the draft')
    const root = surfaceLayout({
      transcript: rowsOf('row', 40),
      dock: rowsOf('dock', 16),
      queue: rowsOf('queued', 0),
      prompt,
      status: rowsOf('status', 1),
    })
    const frame = renderLayoutFrame(root, 80, 12, () => {})
    expect(frame.lines).toHaveLength(12)
    // The work board gives up its tail before the reader loses the row they are
    // typing in or the footer that names the session.
    expect(frame.lines.some(line => line.includes('the draft'))).toBe(true)
    expect(frame.lines.some(line => line.includes('status'))).toBe(true)
    const dockRows = frame.lines.filter(line => line.includes('dock')).length
    expect(dockRows).toBeGreaterThan(0)
    expect(dockRows).toBeLessThan(16)
    const draftRow = frame.lines.findIndex(line => line.includes('the draft'))
    const promptBox = getLayoutBoxesAt(frame, 1, draftRow).find(box => box.component === prompt)
    expect(promptBox?.rect.height).toBeGreaterThanOrEqual(PROMPT_MIN_ROWS)
  })

  it('shows the whole work board when the terminal has room for it', () => {
    const { prompt } = promptOf('the draft')
    const root = surfaceLayout({
      transcript: rowsOf('row', 40),
      dock: rowsOf('dock', 16),
      queue: rowsOf('queued', 0),
      prompt,
      status: rowsOf('status', 1),
    })
    const frame = renderLayoutFrame(root, 80, 24, () => {})
    expect(frame.lines.filter(line => line.includes('dock'))).toHaveLength(16)
    expect(frame.lines.some(line => line.includes('the draft'))).toBe(true)
  })

  it('delivers a click in the bar to the editor through the mounted layout', () => {
    const { prompt, editor } = promptOf('abcdef')
    const root = surfaceLayout({
      transcript: rowsOf('row', 40),
      dock: rowsOf('dock', 0),
      queue: rowsOf('queued', 0),
      prompt,
      status: rowsOf('status', 1),
    })
    const frame = renderLayoutFrame(root, 80, 24, () => {})
    const textRow = frame.lines.findIndex(line => line.includes('abcdef'))
    const box = getLayoutBoxesAt(frame, 1, textRow).find(candidate => candidate.component === prompt)
    expect(box).toBeDefined()
    // The transform the renderer applies before it calls the component.
    const event: TuiMouseEvent = {
      type: 'click',
      button: 'left',
      x: 1 - box!.rect.x,
      y: textRow - box!.rect.y,
      screenX: 1,
      screenY: textRow,
      width: box!.rect.width,
      height: box!.rect.height,
      shift: false,
      alt: false,
      ctrl: false,
    }
    expect(dispatchMouseEvent(box!.component, event)).toBeDefined()
    expect(editor.getCursor().col).toBe(0)
  })
})
