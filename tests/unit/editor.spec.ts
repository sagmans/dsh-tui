import { CURSOR_MARKER, CombinedAutocompleteProvider, visibleWidth, type TUI, type TuiMouseEvent } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
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
