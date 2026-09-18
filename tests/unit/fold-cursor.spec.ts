import { describe, expect, it } from 'vitest'
import { FoldCursor } from '@/fold-cursor.ts'

describe('FoldCursor', () => {
  it('accepts a session\'s events in order', () => {
    const cursor = new FoldCursor()
    expect(cursor.accept({ type: 'turn/start', data: {}, seq: 0 })).toBe(true)
    expect(cursor.accept({ type: 'turn/end', data: {}, seq: 1 })).toBe(true)
  })

  it('refuses an event the fold already consumed', () => {
    // The live stream and the log are the same events, so the interrupted fold
    // must not draw a row the stream has drawn already.
    const cursor = new FoldCursor()
    expect(cursor.accept({ type: 'tool/call', data: {}, seq: 7 })).toBe(true)
    expect(cursor.accept({ type: 'tool/call', data: {}, seq: 7 })).toBe(false)
    expect(cursor.accept({ type: 'tool/result', data: {}, seq: 8 })).toBe(true)
  })

  it('refuses an out-of-order replay of an older event', () => {
    const cursor = new FoldCursor()
    cursor.accept({ type: 'turn/start', data: {}, seq: 5 })
    expect(cursor.accept({ type: 'turn/start', data: {}, seq: 4 })).toBe(false)
  })

  it('measures a fresh transcript from its own first event', () => {
    // Sequence numbers belong to a session, so folding another session must not
    // skip its low numbers as if the previous session's had been seen.
    const cursor = new FoldCursor()
    cursor.accept({ type: 'turn/start', data: {}, seq: 40 })
    cursor.reset()
    expect(cursor.accept({ type: 'turn/start', data: {}, seq: 0 })).toBe(true)
  })

  it('forwards an event that carries no sequence number', () => {
    // A source that cannot number its events still has to reach the transcript;
    // the cursor only guards what it can place.
    const cursor = new FoldCursor()
    expect(cursor.accept({ type: 'notice', data: {} })).toBe(true)
    expect(cursor.accept({ type: 'notice', data: {} })).toBe(true)
  })

  it('does not let an unnumbered event consume a place in the sequence', () => {
    const cursor = new FoldCursor()
    cursor.accept({ type: 'notice', data: {} })
    expect(cursor.accept({ type: 'turn/start', data: {}, seq: 0 })).toBe(true)
  })
})
