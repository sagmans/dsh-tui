import { describe, expect, it, vi } from 'vitest'
import { installSignalRestore } from '@/terminal/signals.ts'

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
  })
})
