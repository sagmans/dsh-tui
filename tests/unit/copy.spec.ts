import { describe, expect, it } from 'vitest'
import { sliceByColumn, visibleWidth } from '@earendil-works/pi-tui'
import { cleanCopied } from '@/ui/copy.ts'
import { frameBlock, type FrameRow } from '@/ui/frame.ts'

/** A block as the surface draws it, with the frame painted as nothing so it reads plainly. */
const block = (lines: readonly string[], width = 12, framed = true): ReturnType<typeof frameBlock> =>
  frameBlock(lines, width, { text: line => line, border: rule => rule, framed })

/** The rows of a block as the terminal hands a copy back: styling gone, trailing blanks gone. */
const reader = (drawn: readonly string[]): string => drawn.map(line => line.replace(/\u001b\[[0-9;]*m/g, '').trimEnd()).join('\n')

/** The text of a boxed message as a reader dragging across it would take it: rows, then a column range. */
const drag = (drawn: readonly string[], from: [number, number], to: [number, number]): string => {
  const lines: string[] = []
  for (let row = from[0]; row <= to[0]; row += 1) {
    const line = drawn[row] ?? ''
    const start = row === from[0] ? from[1] : 0
    const end = row === to[0] ? to[1] : visibleWidth(line)
    lines.push(sliceByColumn(line, start, Math.max(0, end - start), true).trimEnd())
  }
  return lines.join('\n')
}

describe('a copied selection', () => {
  it('reads a message back as its words, with the box left behind', () => {
    const drawn = block(['hello', 'world'])
    expect(cleanCopied(reader(drawn.drawn), drawn.copy)).toBe('hello\nworld')
  })

  it('drops the rules a reader dragged across, since they carry no text of their own', () => {
    const drawn = block(['hello'])
    expect(cleanCopied(reader([drawn.drawn[0]!, drawn.drawn.at(-1)!]), drawn.copy)).toBe('')
  })

  it('reads a drag that starts and ends inside the text, taking the frame columns with it', () => {
    const drawn = block(['hello', 'world'])
    // From the box side on the first row to partway through the second: what a
    // reader gets when they drag over the message rather than around it.
    expect(cleanCopied(drag(drawn.drawn, [1, 0], [2, 8]), drawn.copy)).toBe('hello\nworld')
    expect(cleanCopied(drag(drawn.drawn, [1, 2], [1, 5]), drawn.copy)).toBe('hel')
    expect(cleanCopied(drag(drawn.drawn, [1, 2], [2, 7]), drawn.copy)).toBe('hello\nworld')
  })

  it('keeps the two messages of an exchange apart without keeping their frames', () => {
    const first = block(['one'])
    const second = block(['two'])
    const rows: FrameRow[] = [...first.copy, ...second.copy]
    expect(cleanCopied(reader([...first.drawn, ...second.drawn]), rows)).toBe('one\ntwo')
  })

  it('hands back a line it never drew exactly as it came', () => {
    const drawn = block(['hello'])
    const stranger = 'a row from somewhere else'
    expect(cleanCopied(reader([drawn.drawn[0]!, stranger, drawn.drawn[1]!]), drawn.copy)).toBe([stranger, 'hello'].join('\n'))
  })

  it('leaves a blank line blank rather than letting it stand for the first row', () => {
    const drawn = block(['hello'])
    expect(cleanCopied(['', 'hello'].join('\n'), drawn.copy)).toBe(['', 'hello'].join('\n'))
  })

  it('keeps the indentation a message wrote, which is text and not padding', () => {
    const drawn = block(['    indented', '', 'after'], 20)
    expect(cleanCopied(reader(drawn.drawn), drawn.copy)).toBe('    indented\n\nafter')
  })

  it('counts columns rather than characters, so a wide glyph survives a fragment', () => {
    const drawn = block(['漢字 and back'], 20)
    // The side and padding are two columns, so a drag from the third column starts
    // at the first wide glyph and a fragment of one glyph has to be one glyph.
    expect(cleanCopied(drag(drawn.drawn, [1, 2], [1, 6]), drawn.copy)).toBe('漢字')
    expect(cleanCopied(drag(drawn.drawn, [1, 4], [1, 8]), drawn.copy)).toBe('字 a')
  })

  it('leaves the rows of a block alone when the reader has hidden the frame', () => {
    const drawn = block(['hello', 'world'], 12, false)
    expect(cleanCopied(reader(drawn.drawn), drawn.copy)).toBe('hello\nworld')
  })

  it('takes nothing away when it has no account of the drawing', () => {
    expect(cleanCopied('│ hello │', [])).toBe('│ hello │')
    expect(cleanCopied('', [])).toBe('')
  })
})
