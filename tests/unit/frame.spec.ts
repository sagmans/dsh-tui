import { describe, expect, it } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'
import { bandLines, FRAME_COLUMNS, FRAME_GLYPHS, frameText, MIN_BOX_WIDTH, textRow, type FrameFaces } from '@/ui/frame.ts'

const PLAIN: FrameFaces = { text: line => line, border: rule => rule, drawn: false }
const DRAWN: FrameFaces = { text: line => line, border: rule => rule, drawn: true }

/**
 * One end of a band, so a spec pins the shape of an edge rather than a run of
 * dashes: the corners are the whole of what tells the two ends apart.
 */
const edge = (width: number, ends: { readonly left: string; readonly right: string }): string =>
  `${ends.left}${'─'.repeat(width - FRAME_COLUMNS)}${ends.right}`
const OPEN = { left: FRAME_GLYPHS.topLeft, right: FRAME_GLYPHS.topRight } as const
const CLOSE = { left: FRAME_GLYPHS.bottomLeft, right: FRAME_GLYPHS.bottomRight } as const

describe('frame rows', () => {
  it('pads a row to the bar width and never past it', () => {
    // A bar can be narrower than its own padding, which a full row would overrun.
    for (const width of [0, 1, 2, FRAME_COLUMNS, MIN_BOX_WIDTH]) {
      expect(visibleWidth(textRow('answer', width))).toBeLessThanOrEqual(width)
    }
  })

  it('cuts a row carrying a wide glyph to the bar instead of overhanging it', () => {
    expect(visibleWidth(textRow('日本', 4))).toBeLessThanOrEqual(4)
  })

  it('draws a framed bar at its minimum width without losing an edge', () => {
    const rows = frameText('answer', MIN_BOX_WIDTH, DRAWN)
    expect(rows.every(row => visibleWidth(row) <= MIN_BOX_WIDTH)).toBe(true)
    expect(rows[0]).toBe(`${FRAME_GLYPHS.topLeft}${'─'.repeat(MIN_BOX_WIDTH - FRAME_COLUMNS)}${FRAME_GLYPHS.topRight}`)
    expect(rows.at(-1)?.endsWith(FRAME_GLYPHS.bottomRight)).toBe(true)
  })
})

describe('band rows', () => {
  it('hands a row back exactly as it was, so a copy of it is the text alone', () => {
    // This is the whole reason a band draws no sides: what a reader selects out
    // of the transcript must not carry the frame that held it.
    expect(bandLines(['answer'], 40, DRAWN)).toEqual([edge(40, OPEN), 'answer', edge(40, CLOSE)])
  })

  it('spends no column of its own on a narrow terminal either', () => {
    // A box gives up below its minimum width and stops framing at all; a band
    // has no furniture to run out of room for, and below the two columns a pair
    // of corners needs it closes on the rule alone rather than overrun the row.
    expect(bandLines(['answer'], 1, DRAWN)).toEqual(['─', 'answer', '─'])
  })

  it('opens and closes differently, so two blocks in a row are two blocks', () => {
    // This is what a band has instead of sides: a block that ended must not read
    // as one that began, or the rows between two of them look like a block of
    // their own.
    const rows = bandLines(['answer'], 20, DRAWN)
    expect(rows[0]).not.toBe(rows.at(-1))
    expect(rows[0]).toBe(edge(20, OPEN))
    expect(rows.at(-1)).toBe(edge(20, CLOSE))
  })

  it('draws the rows alone when the reader has hidden the border', () => {
    expect(bandLines(['answer'], 40, PLAIN)).toEqual(['answer'])
  })

  it('counts a folded tail on the closing rule, the way a box does', () => {
    const rows = bandLines(['one', 'two', 'three'], 20, DRAWN, 1)
    expect(rows[0]).toBe(edge(20, OPEN))
    expect(rows.at(-1)).toContain('↓ 2 more')
  })
})
