/**
 * The margin leaf: how wide the air is, what it draws, and that it follows the
 * setting that owns it instead of a count captured when the tree was built.
 */

import { describe, expect, it } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'
import { Gutter } from '@/ui/gutter.ts'

describe('the surface gutter', () => {
  it('is exactly as wide as the reader asked, and draws nothing', () => {
    const rows = new Gutter(() => 3).render()
    expect(rows).toHaveLength(1)
    expect(visibleWidth(rows[0] ?? '')).toBe(3)
    expect((rows[0] ?? '').trim()).toBe('')
  })

  it('reads the count again on every frame, so an edit needs no rebuild', () => {
    let columns = 0
    const gutter = new Gutter(() => columns)
    expect(gutter.render()[0]).toBe('')
    columns = 2
    expect(visibleWidth(gutter.render()[0] ?? '')).toBe(2)
  })

  it('takes no columns from the surface when the count is nonsense', () => {
    // A count the reader cannot see is worse than no margin: a negative or
    // fractional value has to draw nothing rather than eat the transcript's width.
    expect(new Gutter(() => -2).render()[0]).toBe('')
    expect(new Gutter(() => 1.7).render()[0]).toBe(' ')
  })
})
