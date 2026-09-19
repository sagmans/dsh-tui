import { describe, expect, it, vi } from 'vitest'
import { createDeferredNotice } from '../../src/settings-notice.ts'

describe('createDeferredNotice', () => {
  it('prints a notice straight away once the screen owns the output', () => {
    const notice = createDeferredNotice()
    const sink = vi.fn()
    notice.open(sink)
    notice.post('ignoring dsh-tui settings: nope')
    expect(sink).toHaveBeenCalledExactlyOnceWith('ignoring dsh-tui settings: nope')
  })

  it('holds a notice found before the screen exists, then prints it at open', () => {
    const notice = createDeferredNotice()
    const sink = vi.fn()
    notice.post('ignoring dsh-tui settings: nope')
    expect(sink).not.toHaveBeenCalled()
    notice.open(sink)
    expect(sink).toHaveBeenCalledExactlyOnceWith('ignoring dsh-tui settings: nope')
  })

  it('prints a held notice once, not again on a later post', () => {
    const notice = createDeferredNotice()
    const sink = vi.fn()
    notice.post('first')
    notice.open(sink)
    notice.post('second')
    expect(sink.mock.calls).toEqual([['first'], ['second']])
  })
})
