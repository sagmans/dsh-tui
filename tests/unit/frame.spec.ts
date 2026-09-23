import { describe, expect, it } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'
import { bandLines, FRAME_COLUMNS, FRAME_GLYPHS, frameText, MIN_BOX_WIDTH, textRow, type FrameFaces } from '@/ui/frame.ts'

const PLAIN: FrameFaces = { text: line => line, border: rule => rule, drawn: false }
const DRAWN: FrameFaces = { text: line => line, border: rule => rule, drawn: true }

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
    expect(bandLines(['answer'], 40, DRAWN)).toEqual(['─'.repeat(40), 'answer', '─'.repeat(40)])
  })

  it('spends no column of its own on a narrow terminal either', () => {
    // A box gives up below its minimum width and stops framing at all; a band
    // has no furniture to run out of room for.
    expect(bandLines(['answer'], 1, DRAWN)).toEqual(['─', 'answer', '─'])
  })

  it('draws the rows alone when the reader has hidden the border', () => {
    expect(bandLines(['answer'], 40, PLAIN)).toEqual(['answer'])
  })

  it('counts a folded tail on the closing rule, the way a box does', () => {
    const rows = bandLines(['one', 'two', 'three'], 20, DRAWN, 1)
    expect(rows[0]).toBe('─'.repeat(20))
    expect(rows.at(-1)).toContain('↓ 2 more')
  })
})
