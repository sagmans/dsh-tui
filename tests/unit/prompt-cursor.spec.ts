import { CURSOR_MARKER, StdinBuffer, type Terminal, type TUI } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'
import { WarningSafeTui } from '@/terminal/warning-screen.ts'
import { BoxedEditor } from '@/ui/editor.ts'
import { createTheme } from '@/theme.ts'

const WIDTH = 30
const HEIGHT = 24
const FOCUS_IN = '\x1b[I'
const FOCUS_OUT = '\x1b[O'
const CURSOR_SHOW = '\x1b[?25h'
const CURSOR_HIDE = '\x1b[?25l'
const CURSOR_REVERSE = '\x1b[7m'
const SAVE_MODES = '\x1b[?12s\x1b[?1004s'
const ENABLE_MODES = '\x1b[?12h\x1b[?1004h'
const RESTORE_MODES = '\x1b[?1004r\x1b[?12r'
const EXIT_SCREEN = '\x1b[?1049l'
const TEXT = '中😀e\u0301'
const HOME_KEY = '\x1b[H'
const START_FAILURE = 'terminal start failed'
const RESTORE_FAILURE = 'cursor restore failed'

/** A real native renderer with captured terminal delivery exposes focus and redraw regressions. */
function screen() {
  const writes: string[] = []
  let input: (data: string) => void = () => {}
  const terminal = {
    start: (receive: (data: string) => void) => { input = receive },
    stop: vi.fn(), write: (data: string) => { writes.push(data) },
    columns: WIDTH, rows: HEIGHT, kittyProtocolActive: false,
    moveBy: () => {}, hideCursor: () => { writes.push(CURSOR_HIDE) },
    showCursor: () => { writes.push(CURSOR_SHOW) }, clearLine: () => {},
    clearFromCursor: () => {}, clearScreen: () => {}, setTitle: () => {}, setProgress: () => {},
  } as unknown as Terminal
  const tui = new WarningSafeTui(terminal)
  const editor = new BoxedEditor(tui, createTheme('none').editor)
  tui.addChild(editor)
  tui.setFocus(editor)
  return { tui, editor, writes, input: (data: string) => input(data), terminal }
}

describe('native prompt cursor', () => {
  it.each([true, false])('preserves Unicode without a permanent highlight when focused=%s', focused => {
    const tui = { terminal: { rows: HEIGHT, columns: WIDTH }, requestRender: () => {} } as unknown as TUI
    const editor = new BoxedEditor(tui, createTheme('none').editor)
    editor.setText(TEXT)
    editor.handleInput(HOME_KEY)
    editor.focused = focused
    const rendered = editor.render(WIDTH).join('\n')
    expect(rendered).toContain(TEXT)
    expect(rendered).not.toContain(CURSOR_REVERSE)
    expect(rendered.includes(CURSOR_MARKER)).toBe(focused)
  })

  it('keeps ghost text dim without painting a second cursor', () => {
    const tui = { terminal: { rows: HEIGHT, columns: WIDTH }, requestRender: () => {} } as unknown as TUI
    const paint = vi.fn((text: string, cell: string) => cell === 'cursor' ? CURSOR_REVERSE + text : text)
    const editor = new BoxedEditor(tui, createTheme('none').editor, undefined, {
      enabled: () => true, suggestion: () => TEXT, paint,
    })
    editor.focused = true
    const rendered = editor.render(WIDTH).join('\n')
    expect(rendered).toContain(TEXT)
    expect(rendered).toContain(CURSOR_MARKER)
    expect(rendered).not.toContain(CURSOR_REVERSE)
  })

  it('requests native blinking and preserves modes across repeated stop and restart', () => {
    const { tui, writes } = screen()
    try {
      tui.start()
      tui.renderNow()
      expect(writes.join('')).toContain(SAVE_MODES + ENABLE_MODES)
      expect(writes.at(-1)).toContain(CURSOR_SHOW)
      tui.stop({ preserveScreen: true })
      tui.stop({ preserveScreen: true })
      expect(writes.join('').split(RESTORE_MODES)).toHaveLength(2)
      expect(writes.join('').indexOf(RESTORE_MODES)).toBeGreaterThan(writes.join('').indexOf(EXIT_SCREEN))
      tui.start()
      tui.renderNow()
      expect(writes.at(-1)).toContain(CURSOR_SHOW)
    } finally { tui.stop({ preserveScreen: true }) }
    expect(writes.join('').split(RESTORE_MODES)).toHaveLength(3)
  })

  it('consumes fragmented focus reports without changing widget ownership or draft', () => {
    const { tui, editor, writes, input } = screen()
    const laterListener = vi.fn()
    tui.addInputListener(laterListener)
    const buffer = new StdinBuffer()
    buffer.on('data', input)
    try {
      tui.start()
      editor.setText(TEXT)
      buffer.process('\x1b[')
      buffer.process('O')
      tui.renderNow()
      expect(writes.at(-1)).toContain(CURSOR_HIDE)
      expect(writes.at(-1)).not.toContain(CURSOR_SHOW)
      expect(editor.focused).toBe(true)
      expect(editor.getText()).toBe(TEXT)
      expect(laterListener).not.toHaveBeenCalled()
      input(FOCUS_IN)
      tui.renderNow()
      expect(writes.at(-1)).toContain(CURSOR_SHOW)
      expect(editor.getText()).toBe(TEXT)
      expect(laterListener).not.toHaveBeenCalled()
    } finally { buffer.destroy(); tui.stop({ preserveScreen: true }) }
  })

  it('preserves application listener identity for explicit removal', () => {
    const { tui, input } = screen()
    const listener = vi.fn()
    tui.addInputListener(listener)
    tui.removeInputListener(listener)
    try {
      tui.start()
      input(TEXT)
      expect(listener).not.toHaveBeenCalled()
    } finally { tui.stop({ preserveScreen: true }) }
  })

  it('restores saved modes and warning ownership after partial startup failure', () => {
    const { tui, terminal, writes } = screen()
    const originalEmit = process.emit
    vi.spyOn(terminal, 'start').mockImplementation(() => { throw new Error(START_FAILURE) })
    expect(() => tui.start()).toThrow(START_FAILURE)
    expect(writes.join('')).toContain(RESTORE_MODES)
    expect(process.emit).toBe(originalEmit)
  })

  it('releases warning and host-write guards even when cursor restoration throws', () => {
    const { tui, terminal } = screen()
    const originalEmit = process.emit
    const originalWrite = process.stdout.write
    const write = terminal.write.bind(terminal)
    tui.start()
    vi.spyOn(terminal, 'write').mockImplementation(data => {
      if (data === RESTORE_MODES) throw new Error(RESTORE_FAILURE)
      write(data)
    })
    expect(() => tui.stop({ preserveScreen: true })).toThrow(RESTORE_FAILURE)
    expect(process.emit).toBe(originalEmit)
    expect(process.stdout.write).toBe(originalWrite)
  })

  it('ignores late focus reports after a terminal handoff', () => {
    const { tui, writes, input } = screen()
    tui.start()
    input(FOCUS_OUT)
    tui.stop({ preserveScreen: true })
    const before = writes.join('')
    input(FOCUS_IN)
    input(FOCUS_OUT)
    expect(writes.join('')).toBe(before)
  })

  it('keeps borrowed question focus and hides again on background redraws', () => {
    const { tui, editor, writes, input } = screen()
    try {
      tui.start()
      tui.setFocus(null)
      editor.disableSubmit = true
      editor.focused = true
      input(FOCUS_OUT)
      tui.renderNow()
      editor.setText(TEXT)
      tui.renderNow()
      expect(writes.at(-1)).toContain(CURSOR_HIDE)
      expect(editor.focused).toBe(true)
      input(FOCUS_IN)
      tui.renderNow()
      expect(writes.at(-1)).toContain(CURSOR_SHOW)
      tui.setFocus(null)
      editor.focused = false
      tui.renderNow()
      expect(writes.at(-1)).toContain(CURSOR_HIDE)
    } finally { tui.stop({ preserveScreen: true }) }
  })
})
