import { describe, expect, it } from 'vitest'
import { assertInteractiveTerminal } from '@/index.ts'

describe('assertInteractiveTerminal', () => {
  it('accepts a real terminal on both streams', () => {
    expect(() => assertInteractiveTerminal({ stdinIsTTY: true, stdoutIsTTY: true })).not.toThrow()
  })

  it('refuses a piped stream instead of degrading to line mode', () => {
    expect(() => assertInteractiveTerminal({ stdinIsTTY: false, stdoutIsTTY: true })).toThrow(/must be TTYs/)
    expect(() => assertInteractiveTerminal({ stdinIsTTY: true, stdoutIsTTY: false })).toThrow(/must be TTYs/)
  })
})
