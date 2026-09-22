import { describe, expect, it, vi } from 'vitest'
import { installSignalRestore, TERMINATING_SIGNALS } from '@/terminal/signals.ts'

describe('installSignalRestore', () => {
  it('restores once with the status the signal asks for, then stops listening', () => {
    const shutdown = vi.fn()
    const before = process.listenerCount('SIGTERM')
    const remove = installSignalRestore({ shutdown })
    try {
      expect(process.listenerCount('SIGTERM')).toBe(before + 1)
      process.emit('SIGTERM', 'SIGTERM')
      expect(shutdown).toHaveBeenCalledWith(143, 'SIGTERM')
      // The listener is gone before the shutdown runs, so a second signal cannot
      // ask a surface that is already leaving to leave again.
      expect(process.listenerCount('SIGTERM')).toBe(before)
    } finally {
      remove()
    }
    expect(TERMINATING_SIGNALS).toContain('SIGTERM')
  })

  it('installs only the signals it is given', () => {
    const shutdown = vi.fn()
    const before = process.listenerCount('SIGHUP')
    const remove = installSignalRestore({ shutdown, signals: ['SIGTERM'] })
    try {
      expect(process.listenerCount('SIGHUP')).toBe(before)
    } finally {
      remove()
    }
  })
})
