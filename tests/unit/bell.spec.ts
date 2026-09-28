import { describe, expect, it } from 'vitest'
import { BELL } from '@/terminal/bell.ts'

describe('terminal bell', () => {
  it('rings with the character the terminal listens for', () => {
    expect(BELL).toBe('\u0007')
  })
})
