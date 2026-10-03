import { describe, expect, it, vi } from 'vitest'
import { stripTerminalSequences, type Component, type TUI, type TuiMouseEvent } from '@earendil-works/pi-tui'
import { getLayoutBoxesAt, renderLayoutFrame } from '@earendil-works/pi-tui/dist/layout.js'
import { dispatchMouseEvent } from '@earendil-works/pi-tui/dist/tui.js'
import { createTheme } from '@/theme.ts'
import { BoxedEditor } from '@/ui/editor.ts'
import { PROMPT_MIN_ROWS, surfaceLayout } from '@/ui/layout.ts'
import { PromptBar } from '@/ui/prompt.ts'

const MAX_PROMPT_RENDER_PASSES = 2
const TINY_HEIGHTS = [1, 2, 3]
const TINY_WIDTHS = [20, 40, 80, 120, 200]
const TINY_DRAFT = 'draft'
const TINY_FOOTER = 'status'
const LARGE_TRANSCRIPT_ROWS = 40
const LARGE_DOCK_ROWS = 16
const LARGE_QUEUE_ROWS = 8
const MULTILINE_FOOTER_ROWS = 8

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
  it.each(TINY_HEIGHTS.flatMap(height => TINY_WIDTHS.map(width => ({ height, width }))))(
    'keeps input at $width columns by $height rows under dock and queue pressure', ({ height, width }) => {
      const { prompt, editor } = promptOf(TINY_DRAFT)
      const root = surfaceLayout({
        transcript: rowsOf('row', LARGE_TRANSCRIPT_ROWS),
        dock: rowsOf('dock', LARGE_DOCK_ROWS),
        queue: rowsOf('queued', LARGE_QUEUE_ROWS),
        prompt,
        status: rowsOf(TINY_FOOTER, MULTILINE_FOOTER_ROWS),
      })
      const frame = renderLayoutFrame(root, width, height, () => {})
      expect(frame.lines).toHaveLength(height)
      expect(frame.lines.some(line => line.includes(TINY_DRAFT))).toBe(true)
      if (height > 1) expect(frame.lines.some(line => line.includes(TINY_FOOTER))).toBe(true)
      expect(editor.getText()).toBe(TINY_DRAFT)
    },
  )

  it('does not add an editor measurement beyond the prompt layout and placement', () => {
    const { prompt, editor } = promptOf('the draft')
    const render = vi.spyOn(editor, 'render')
    const root = surfaceLayout({
      transcript: rowsOf('row', 40),
      dock: rowsOf('dock', 16),
      queue: rowsOf('queued', 0),
      prompt,
      status: rowsOf('status', 1),
    })

    const frame = renderLayoutFrame(root, 80, 12, () => {})

    expect(frame.lines.some(line => line.includes('the draft'))).toBe(true)
    // pi-tui measures the prompt before placing its editor; another wrapper costs a third pass.
    expect(render.mock.calls.length).toBeLessThanOrEqual(MAX_PROMPT_RENDER_PASSES)
  })

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

  it('leaves one blank row above and below the prompt without changing its text', () => {
    const { prompt, editor } = promptOf('the draft')
    const root = surfaceLayout({
      transcript: rowsOf('row', 40),
      dock: rowsOf('dock', 0),
      queue: rowsOf('queued', 1),
      prompt,
      status: rowsOf('status', 1),
    })
    const frame = renderLayoutFrame(root, 80, 24, () => {})
    const draftRow = frame.lines.findIndex(line => line.includes('the draft'))
    expect(stripTerminalSequences(frame.lines[draftRow - 1]!).trim()).toBe('')
    expect(stripTerminalSequences(frame.lines[draftRow + 1]!).trim()).toBe('')
    expect(frame.lines[draftRow - 2]).toContain('queued 0')
    expect(frame.lines[draftRow + 2]).toContain('status 0')
    expect(editor.getText()).toBe('the draft')
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

  it('insets the conversation and leaves the bars at the window\'s edges', () => {
    const { prompt } = promptOf('the draft')
    const root = surfaceLayout({
      transcript: rowsOf('row', 6),
      dock: rowsOf('dock', 2),
      queue: rowsOf('queued', 0),
      prompt,
      status: rowsOf('status', 1),
    }, () => 1)
    const frame = renderLayoutFrame(root, 40, 12, () => {})
    // The conversation and the work boards under it begin one column in, inside a
    // margin that costs them two columns of width.
    const rowAt = frame.lines.findIndex(line => line.includes('row 0'))
    const dockRow = frame.lines.findIndex(line => line.includes('dock 0'))
    expect(stripTerminalSequences(frame.lines[rowAt]!)[0]).toBe(' ')
    expect(getLayoutBoxesAt(frame, 1, rowAt)[0]?.rect).toMatchObject({ x: 1, width: 38 })
    expect(getLayoutBoxesAt(frame, 1, dockRow)[0]?.rect).toMatchObject({ x: 1, width: 38 })
    // The bar the reader types in keeps the full width: a bar inset on both sides
    // would read as one more card of the conversation rather than as the input.
    const draftRow = frame.lines.findIndex(line => line.includes('the draft'))
    const promptBox = getLayoutBoxesAt(frame, 1, draftRow).find(box => box.component === prompt)
    expect(promptBox?.rect).toMatchObject({ x: 0, width: 40 })
  })

  it('maps a prompt click to the editor hit box and cursor position', () => {
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
    const boxes = getLayoutBoxesAt(frame, 1, textRow)
    // A wrapper hit would not establish that the editor received this cursor click.
    const box = boxes[0]
    expect(box?.component).toBe(editor)
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
