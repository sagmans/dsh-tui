import { describe, expect, it, vi } from 'vitest'
import { createDeferredNotice } from '@/settings-notice.ts'

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

  it('drops a message that repeats the one just posted', () => {
    const notice = createDeferredNotice()
    const sink = vi.fn()
    notice.open(sink)
    // One write can be read twice: the section and the document it came from.
    notice.post('ignoring dsh-tui settings: spacing.padding must be an integer between 0 and 3')
    notice.post('ignoring dsh-tui settings: spacing.padding must be an integer between 0 and 3')
    expect(sink).toHaveBeenCalledExactlyOnceWith('ignoring dsh-tui settings: spacing.padding must be an integer between 0 and 3')
  })

  it('collapses a repeat found before the screen exists too', () => {
    const notice = createDeferredNotice()
    const sink = vi.fn()
    notice.post('ignoring dsh-tui settings: nope')
    notice.post('ignoring dsh-tui settings: nope')
    notice.open(sink)
    expect(sink).toHaveBeenCalledExactlyOnceWith('ignoring dsh-tui settings: nope')
  })

  it('still reports a refusal that follows a different one', () => {
    const notice = createDeferredNotice()
    const sink = vi.fn()
    notice.open(sink)
    notice.post('first')
    notice.post('second')
    // The same sentence again is a second occurrence once something was said between.
    notice.post('first')
    expect(sink.mock.calls).toEqual([['first'], ['second'], ['first']])
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
