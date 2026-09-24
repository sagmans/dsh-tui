import type { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { FoldCursor, ViewGeneration, replayIfCurrent } from '@/fold-cursor.ts'

/** A sequence number only means something inside the session that issued it. */
const SESSION = 'session-a' as SessionId
const OTHER_SESSION = 'session-b' as SessionId

describe('FoldCursor', () => {
  it('accepts a session\'s events in order', () => {
    const cursor = new FoldCursor()
    expect(cursor.accept(SESSION, { type: 'turn/start', data: {}, seq: 0 })).toBe(true)
    expect(cursor.accept(SESSION, { type: 'turn/end', data: {}, seq: 1 })).toBe(true)
  })

  it('refuses an event the fold already consumed', () => {
    // The live stream and the log are the same events, so the interrupted fold
    // must not draw a row the stream has drawn already.
    const cursor = new FoldCursor()
    expect(cursor.accept(SESSION, { type: 'tool/call', data: {}, seq: 7 })).toBe(true)
    expect(cursor.accept(SESSION, { type: 'tool/call', data: {}, seq: 7 })).toBe(false)
    expect(cursor.accept(SESSION, { type: 'tool/result', data: {}, seq: 8 })).toBe(true)
  })

  it('refuses an out-of-order replay of an older event', () => {
    const cursor = new FoldCursor()
    cursor.accept(SESSION, { type: 'turn/start', data: {}, seq: 5 })
    expect(cursor.accept(SESSION, { type: 'turn/start', data: {}, seq: 4 })).toBe(false)
  })

  it('measures a fresh transcript from its own first event', () => {
    // Folding a session again re-reads it from the start, so the place the
    // previous fold reached has to be given up.
    const cursor = new FoldCursor()
    cursor.accept(SESSION, { type: 'turn/start', data: {}, seq: 40 })
    cursor.reset()
    expect(cursor.accept(SESSION, { type: 'turn/start', data: {}, seq: 0 })).toBe(true)
  })

  it('measures another session from its own first event', () => {
    // A transcript that starts on a session other than the one just read — what
    // `/new` does — must not measure the new session against the old one's
    // numbering: every row of the new conversation would be dropped.
    const cursor = new FoldCursor()
    cursor.accept(SESSION, { type: 'turn/start', data: {}, seq: 40 })
    expect(cursor.accept(OTHER_SESSION, { type: 'user/message', data: {}, seq: 0 })).toBe(true)
    expect(cursor.accept(OTHER_SESSION, { type: 'turn/start', data: {}, seq: 1 })).toBe(true)
  })

  it('forwards an event that carries no sequence number', () => {
    // A source that cannot number its events still has to reach the transcript;
    // the cursor only guards what it can place.
    const cursor = new FoldCursor()
    expect(cursor.accept(SESSION, { type: 'notice', data: {} })).toBe(true)
    expect(cursor.accept(SESSION, { type: 'notice', data: {} })).toBe(true)
  })

  it('does not let an unnumbered event consume a place in the sequence', () => {
    const cursor = new FoldCursor()
    cursor.accept(SESSION, { type: 'notice', data: {} })
    expect(cursor.accept(SESSION, { type: 'turn/start', data: {}, seq: 0 })).toBe(true)
  })
})

describe('replayIfCurrent', () => {
  it('discards delayed child logs when another child or the parent view wins', async () => {
    const pending: ((events: readonly string[]) => void)[] = []
    const read = (): Promise<readonly string[]> => new Promise(resolve => { pending.push(resolve) })
    const painted: string[] = []
    let viewed = 'first'
    const first = replayIfCurrent(read, () => viewed === 'first', event => { painted.push(event) })
    viewed = 'second'
    const second = replayIfCurrent(read, () => viewed === 'second', event => { painted.push(event) })
    viewed = 'parent'
    const back = replayIfCurrent(read, () => viewed === 'parent', event => { painted.push(event) })
    pending[2]?.(['parent message'])
    expect(await back).toBe(1)
    pending[0]?.(['first child message'])
    pending[1]?.(['second child message'])
    expect(await Promise.all([first, second])).toEqual([0, 0])
    expect(painted).toEqual(['parent message'])
  })

  it('discards a child read when a driven session resets before opening', async () => {
    const views = new ViewGeneration()
    let resolveRead: ((events: readonly string[]) => void) | undefined
    const read = (): Promise<readonly string[]> => new Promise(resolve => { resolveRead = resolve })
    const painted: string[] = []
    const child = replayIfCurrent(read, views.begin(), event => { painted.push(event) })
    views.begin()
    resolveRead?.(['stale child message'])
    expect(await child).toBe(0)
    expect(painted).toEqual([])
  })
})
