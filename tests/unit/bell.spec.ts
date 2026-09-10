import { describe, expect, it } from 'vitest'
import { BELL, BELL_AFTER_MS, shouldRingBell } from '@/terminal/bell.ts'

describe('shouldRingBell', () => {
  it('rings only for a turn long enough to have walked away from', () => {
    expect(shouldRingBell({ bell: true, ranForMs: BELL_AFTER_MS, exiting: false })).toBe(true)
    expect(shouldRingBell({ bell: true, ranForMs: BELL_AFTER_MS - 1, exiting: false })).toBe(false)
  })

  it('stays quiet when the reader turned it off', () => {
    expect(shouldRingBell({ bell: false, ranForMs: BELL_AFTER_MS * 5, exiting: false })).toBe(false)
  })

  it('stays quiet while the surface is leaving', () => {
    expect(shouldRingBell({ bell: true, ranForMs: BELL_AFTER_MS * 5, exiting: true })).toBe(false)
  })

  it('rings with the character the terminal listens for', () => {
    expect(BELL).toBe('\u0007')
  })
})
