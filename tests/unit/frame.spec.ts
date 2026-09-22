import { describe, expect, it } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'
import { FRAME_COLUMNS, FRAME_GLYPHS, frameText, MIN_BOX_WIDTH, textRow, type FrameFaces } from '@/ui/frame.ts'

const PLAIN: FrameFaces = { text: line => line, border: rule => rule, framed: false }
const FRAMED: FrameFaces = { text: line => line, border: rule => rule, framed: true }

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
    const rows = frameText('answer', MIN_BOX_WIDTH, FRAMED)
    expect(rows.every(row => visibleWidth(row) <= MIN_BOX_WIDTH)).toBe(true)
    expect(rows[0]).toBe(`${FRAME_GLYPHS.topLeft}${'─'.repeat(MIN_BOX_WIDTH - FRAME_COLUMNS)}${FRAME_GLYPHS.topRight}`)
    expect(rows.at(-1)?.endsWith(FRAME_GLYPHS.bottomRight)).toBe(true)
  })
})
