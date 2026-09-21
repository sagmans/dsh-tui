import {
  CURSOR_MARKER,
  CombinedAutocompleteProvider,
  getKeybindings,
  setKittyProtocolActive,
  visibleWidth,
  type TUI,
  type TuiMouseEvent,
} from '@earendil-works/pi-tui'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installEditorKeybindings } from '@/input/keymap.ts'
import { createTheme } from '@/theme.ts'
import { BoxedEditor } from '@/ui/editor.ts'

/** The width every frame assertion is drawn at, so one row is one readable string. */
const WIDTH = 30
/** The frame and the air it keeps off the text: one column each side, one more inside. */
const EDGE_AND_PADDING = 2

/** The surface only ever lends the editor its terminal size and a repaint. */
const surface = (): TUI => ({
  terminal: { rows: 24, columns: WIDTH },
  requestRender: () => {},
}) as unknown as TUI

const editor = (): BoxedEditor => {
  const instance = new BoxedEditor(surface(), createTheme('none').editor)
  instance.focused = true
  return instance
}

const mouse = (overrides: Partial<TuiMouseEvent> = {}): TuiMouseEvent => ({
  type: 'click',
  button: 'left',
  x: 1,
  y: 0,
  screenX: 1,
  screenY: 0,
  width: WIDTH,
  height: 3,
  shift: false,
  alt: false,
  ctrl: false,
  ...overrides,
})

const completions = (instance: BoxedEditor): void => {
  instance.setAutocompleteProvider(new CombinedAutocompleteProvider([
    { name: 'help', description: 'show the commands' },
    { name: 'hello', description: 'greet the agent' },
  ], process.cwd()))
}

/** The editor schedules its completion request, so a test waits for it rather than guessing. */
const settle = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  expect(predicate()).toBe(true)
}

describe('BoxedEditor', () => {
  it('joins the editor rules into a box and keeps every row the full width', () => {
    const instance = editor()
    instance.setText('hello')
    const lines = instance.render(WIDTH)
    expect(lines).toHaveLength(3)
    expect(lines[0]!.startsWith('╭')).toBe(true)
    expect(lines[0]!.endsWith('╮')).toBe(true)
    expect(lines[1]!.startsWith('│')).toBe(true)
    expect(lines[1]!.endsWith('│')).toBe(true)
    expect(lines[1]!.startsWith('│ hello')).toBe(true)
    expect(lines[2]!.startsWith('╰')).toBe(true)
    expect(lines[2]!.endsWith('╯')).toBe(true)
    for (const line of lines) expect(visibleWidth(line)).toBe(WIDTH)
  })

  it('places the hardware cursor past the frame and the padding', () => {
    const instance = editor()
    instance.setText('hello')
    const row = instance.render(WIDTH).find(line => line.includes(CURSOR_MARKER))
    expect(row).toBeDefined()
    const before = row!.slice(0, row!.indexOf(CURSOR_MARKER))
    expect(visibleWidth(before)).toBe(EDGE_AND_PADDING + 'hello'.length)
  })

  it('shows the completion menu above the box and outside the frame', async () => {
    const instance = editor()
    completions(instance)
    instance.handleInput('/')
    await settle(() => instance.isShowingAutocomplete())
    const lines = instance.render(WIDTH)
    const top = lines.findIndex(line => line.startsWith('╭'))
    expect(top).toBeGreaterThan(0)
    expect(lines[0]).toContain('help')
    expect(lines[1]).toContain('hello')
    expect(lines.slice(top)).toHaveLength(3)
    expect(lines.at(-1)!.startsWith('╰')).toBe(true)
    for (const line of lines) expect(visibleWidth(line)).toBe(WIDTH)
  })

  it('puts the cursor where a click inside the frame lands', () => {
    const instance = editor()
    instance.setText('hello')
    instance.render(WIDTH)
    instance.handleMouse(mouse({ x: EDGE_AND_PADDING + 2, y: 1 }))
    expect(instance.getCursor().col).toBe(2)
  })

  it('selects the completion a click lands on above the box', async () => {
    const instance = editor()
    completions(instance)
    instance.handleInput('/')
    await settle(() => instance.isShowingAutocomplete())
    instance.render(WIDTH)
    instance.handleMouse(mouse({ x: 6, y: 1 }))
    expect(instance.getText()).toBe('/hello ')
  })

  it('leaves the input unframed when the border token is hidden', () => {
    const plain = createTheme('none').editor
    const instance = new BoxedEditor(surface(), { ...plain, borderColor: () => '' })
    instance.setText('hello')
    const lines = instance.render(WIDTH)
    expect(lines.some(line => line.includes('╭') || line.includes('╯') || line.includes('│'))).toBe(false)
    // Without a frame the text owns the whole row: reserving columns for
    // furniture nobody can see would narrow the input for no reader.
    expect(visibleWidth(lines[1]!)).toBe(WIDTH)
  })

  it('draws no frame when the box cannot fit', () => {
    const instance = editor()
    instance.setText('hello')
    const lines = instance.render(3)
    expect(lines.some(line => line.includes('╭'))).toBe(false)
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(3)
  })
})

describe('the prompt keys', () => {
  beforeEach(() => {
    installEditorKeybindings()
  })

  afterEach(() => {
    setKittyProtocolActive(false)
  })

  /** The bar wired to a list of what it sent, so a press either sends or does not. */
  const sender = (): { instance: BoxedEditor; sent: string[] } => {
    const instance = editor()
    const sent: string[] = []
    instance.onSubmit = text => {
      sent.push(text)
    }
    return { instance, sent }
  }

  it('writes a line on Enter rather than sending what is written', () => {
    const { instance, sent } = sender()
    instance.setText('first')
    instance.handleInput('\r')
    instance.handleInput('second')
    expect(instance.getText()).toBe('first\nsecond')
    expect(sent).toEqual([])
  })

  it('writes a line on Shift+Enter and on Ctrl+J', () => {
    const shifted = sender().instance
    shifted.setText('first')
    shifted.handleInput('\u001b[13;2u')
    expect(shifted.getText()).toBe('first\n')

    const controlled = sender().instance
    controlled.setText('first')
    controlled.handleInput('\n')
    expect(controlled.getText()).toBe('first\n')
  })

  it('sends on Ctrl+Enter, Alt+Enter, and Ctrl+S', () => {
    for (const chord of ['\u001b[13;5u', '\u001b[13;3u', '\u0013', '\u001b[27;5;13~']) {
      const { instance, sent } = sender()
      instance.setText('hello')
      instance.handleInput(chord)
      expect(sent, chord).toEqual(['hello'])
      expect(instance.getText(), chord).toBe('')
    }
  })

  it('sends on the alt+enter a terminal without modifiers can spell', () => {
    const { instance, sent } = sender()
    instance.setText('hello')
    instance.handleInput('\u001b\r')
    expect(sent).toEqual(['hello'])
  })

  it('keeps that sequence a newline while the keyboard protocol is active', () => {
    // The protocol reports the modifier, so the same bytes are the terminal's
    // own shift+enter mapping, which is a line and not a send.
    setKittyProtocolActive(true)
    const { instance, sent } = sender()
    instance.setText('hello')
    instance.handleInput('\u001b\r')
    expect(instance.getText()).toBe('hello\n')
    expect(sent).toEqual([])
  })

  it('keeps the send chords out of a bar a question has borrowed', () => {
    const { instance, sent } = sender()
    instance.setText('an answer')
    instance.disableSubmit = true
    instance.handleInput('\r')
    instance.handleInput('\u0013')
    instance.handleInput('\u001b[13;5u')
    expect(instance.getText()).toBe('an answer')
    expect(sent).toEqual([])
  })

  it('keeps Enter for the completion it is confirming', async () => {
    const { instance, sent } = sender()
    completions(instance)
    instance.handleInput('/')
    await settle(() => instance.isShowingAutocomplete())
    instance.handleInput('\r')
    // The menu picks the command; a line break after the pick would be the
    // editor's doing rather than the reader's.
    expect(instance.getText()).toBe('/help ')
    expect(sent).toEqual([])
  })

  it('binds sending where the library reads the key and leaves the newline keys alone', () => {
    const keys = getKeybindings()
    expect(keys.matches('\u0013', 'tui.input.submit')).toBe(true)
    expect(keys.matches('\r', 'tui.input.submit')).toBe(false)
    expect(keys.matches('\r', 'tui.input.newLine')).toBe(false)
    expect(keys.matches('\u001b[13;2u', 'tui.input.newLine')).toBe(true)
    expect(keys.matches('\n', 'tui.input.newLine')).toBe(true)
  })
})
