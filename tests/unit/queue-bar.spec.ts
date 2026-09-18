import { visibleWidth, type TUI } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { createTheme } from '@/theme.ts'
import { parseSettings, toOverrides } from '@/theme-settings.ts'
import { BoxedEditor } from '@/ui/editor.ts'
import { QUEUE_LIMIT, QUEUE_TEXT_ROWS, QueueBar } from '@/ui/queue.ts'

/** The width every frame assertion is drawn at, so one row is one readable string. */
const WIDTH = 30
/** A prompt short enough to stay on one row, so a frame assertion is about the frame. */
const PROMPT = 'update the README'

/** The surface only ever lends the editor its terminal size and a repaint. */
const surface = (): TUI => ({
  terminal: { rows: 24, columns: WIDTH },
  requestRender: () => {},
}) as unknown as TUI

const bar = (prompts: readonly string[], theme = createTheme('none')): QueueBar => new QueueBar(() => prompts, theme)

/** A theme whose one named element is set, for the contracts a reader can change. */
const themed = (tokens: Record<string, Record<string, unknown>>, mode: 'none' | 'truecolor' = 'none') =>
  createTheme(mode, toOverrides(parseSettings({ tokens })))

/** The text a framed row carries, without its sides or its padding. */
const inner = (row: string): string => row.slice(1, -1).trim()

describe('QueueBar', () => {
  it('draws nothing while nothing is waiting', () => {
    expect(bar([]).render(WIDTH)).toEqual([])
  })

  it('draws a queued prompt in the editor bar\'s own frame', () => {
    const editor = new BoxedEditor(surface(), createTheme('none').editor)
    editor.setText(PROMPT)
    const input = editor.render(WIDTH)
    const lines = bar([PROMPT]).render(WIDTH)
    // The rules and the shape are the editor's own, so a reader cannot tell the
    // two bars apart except by the face the message is drawn in.
    expect(lines[0]).toBe(input[0])
    expect(lines[2]).toBe(input[2])
    expect(visibleWidth(lines[1]!)).toBe(visibleWidth(input[1]!))
    expect(lines[1]).toBe(`│ ${PROMPT}${' '.repeat(WIDTH - 4 - PROMPT.length)} │`)
  })

  it('recedes a queued prompt with a faint italic face', () => {
    const lines = bar([PROMPT], createTheme('truecolor')).render(WIDTH)
    expect(lines[1]).toContain(`\u001B[2;3m${PROMPT}\u001B[0m`)
    expect(visibleWidth(lines[1]!)).toBe(WIDTH)
  })

  it('escapes what a prompt carries, so a payload cannot repaint the frame', () => {
    const lines = bar(['a\u001B[31mb']).render(WIDTH)
    expect(lines[1]).toContain('a\\x1B[31mb')
    expect(visibleWidth(lines[1]!)).toBe(WIDTH)
  })

  it('keeps a long prompt to its first rows and counts the rest', () => {
    const lines = bar([['one', 'two', 'three', 'four', 'five'].join('\n')]).render(WIDTH)
    expect(lines).toHaveLength(QUEUE_TEXT_ROWS + 2)
    expect(lines.slice(1, -1).map(inner)).toEqual(['one', 'two', 'three'])
    // The count rides the closing rule, exactly where the editor names its own
    // hidden lines, so the frame costs no row to say what it left out.
    expect(lines.at(-1)).toBe(`╰${'─'.repeat(9)} ↓ 2 more ${'─'.repeat(9)}╯`)
  })

  it('wraps a prompt at the bar\'s own text width', () => {
    const lines = bar(['the quick brown fox jumps over the lazy dog']).render(WIDTH)
    expect(lines).toHaveLength(4)
    expect(lines.slice(1, -1).map(inner)).toEqual(['the quick brown fox jumps', 'over the lazy dog'])
  })

  it('keeps the newest prompts and counts the ones it left out', () => {
    const lines = bar(['one', 'two', 'three', 'four', 'five']).render(WIDTH)
    expect(lines).toHaveLength(1 + QUEUE_LIMIT * 3)
    expect(lines[0]).toBe('… 2 queued earlier')
    // The reader typed the newest one last, so that is the row that must stay
    // reachable; the ones above it are the ones the harness is about to take.
    expect(lines.slice(1).filter(row => row.startsWith('│')).map(inner)).toEqual(['three', 'four', 'five'])
  })

  it('draws no frame when the border token is hidden', () => {
    const lines = bar([PROMPT], themed({ 'editor.border': { hidden: true } })).render(WIDTH)
    expect(lines.some(row => row.includes('╭') || row.includes('╯') || row.includes('│'))).toBe(false)
    expect(lines[0]).toBe(` ${PROMPT}${' '.repeat(WIDTH - 2 - PROMPT.length)} `)
  })

  it('draws nothing when the queued face is hidden', () => {
    expect(bar([PROMPT], themed({ 'editor.queued': { hidden: true } })).render(WIDTH)).toEqual([])
  })

  it('draws no frame when the box cannot fit', () => {
    const lines = bar(['hi']).render(3)
    expect(lines.some(row => row.includes('╭'))).toBe(false)
    for (const row of lines) expect(visibleWidth(row)).toBeLessThanOrEqual(3)
  })
})
