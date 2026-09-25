import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  PRESET_EVENT_LIMIT,
  TITLE_CHAR_LIMIT,
  TITLE_EVENT_LIMIT,
  createSessionHistory,
  presetOfStoredSession,
  readSessionTitle,
  sessionTitle,
  type SessionHistory,
  type StoredEvent,
  type StoredHeader,
} from '@/agent/history.ts'

const user = (text: string, kind = 'user'): StoredEvent => ({
  type: 'user/message',
  data: { content: [{ type: 'text', text }], source: { kind } },
})

describe('sessionTitle', () => {
  it('titles a session with its first human prompt', () => {
    expect(sessionTitle([user('context', 'plugin'), user('fix the parser')])).toBe('fix the parser')
  })

  it('never titles a session after injected context', () => {
    expect(sessionTitle([user('<system-reminder>\nrules', 'plugin')])).toBeUndefined()
  })

  it('collapses whitespace and cuts a title that cannot fit a row', () => {
    expect(sessionTitle([user('  fix\n\n the   parser ')])).toBe('fix the parser')
    const long = sessionTitle([user('x'.repeat(TITLE_CHAR_LIMIT * 2))])
    expect(long).toHaveLength(TITLE_CHAR_LIMIT)
    expect(long?.endsWith('…')).toBe(true)
  })

  it('prefers the title the harness derived or the reader set', () => {
    const titled: StoredEvent = { type: 'session/title', data: { title: 'dock polish', messageSeqs: [], source: 'user' } }
    expect(sessionTitle([user('first prompt'), titled])).toBe('dock polish')
    // Latest wins, exactly as the projection folds it.
    expect(sessionTitle([titled, { type: 'session/title', data: { title: 'later' } }])).toBe('later')
  })

  it('ignores a title that normalizes to nothing', () => {
    expect(sessionTitle([
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'session/title', data: { title: '   ' } },
      user('first prompt'),
    ])).toBe('first prompt')
  })

  it('answers nothing for an empty log', () => {
    expect(sessionTitle([])).toBeUndefined()
  })
})

/** A stored-session seam over one header and one log, honoring slice reads. */
function storedHistory(header: StoredHeader | undefined, events: readonly StoredEvent[] = []): SessionHistory {
  return {
    list: async () => [],
    header: async () => header,
    read: async (_id, options) => events.slice(options?.offset ?? 0, (options?.offset ?? 0) + (options?.limit ?? events.length)),
  }
}

const selected = (agentPreset: unknown): StoredEvent => ({ type: 'agent-preset/selected', data: { agentPreset } })

describe('presetOfStoredSession', () => {
  it('reads the preset a session started with', async () => {
    // A selection is looked for in a tail window, so the header has to answer
    // even when the log is far longer than that window.
    const filler = Array.from({ length: PRESET_EVENT_LIMIT * 3 }, (_, index) => ({ type: 'turn/start', data: { turn: index } }))
    const history = storedHistory({ id: 's', agentPreset: 'ptc', eventCount: filler.length }, filler)
    expect(await presetOfStoredSession(history, 's')).toBe('ptc')
  })

  it('lets a recorded selection outrank the header, last one winning', async () => {
    const history = storedHistory(
      { id: 's', agentPreset: 'standard', eventCount: 3 },
      [selected('ptc'), { type: 'turn/start', data: {} }, selected('minimal')],
    )
    expect(await presetOfStoredSession(history, 's')).toBe('minimal')
  })

  it('finds a selection inside the tail of a long log', async () => {
    const filler = Array.from({ length: PRESET_EVENT_LIMIT * 3 }, (_, index) => ({ type: `turn/start`, data: { turn: index } }))
    const history = storedHistory(
      { id: 's', agentPreset: 'standard', eventCount: filler.length + 1 },
      [...filler, selected('cordis')],
    )
    expect(await presetOfStoredSession(history, 's')).toBe('cordis')
  })

  it('answers nothing for a stored session that recorded no preset', async () => {
    const history = storedHistory({ id: 's', agentPreset: undefined, eventCount: 1 }, [{ type: 'turn/start', data: {} }])
    expect(await presetOfStoredSession(history, 's')).toBeUndefined()
  })

  it('answers nothing when no session is stored under that id', async () => {
    expect(await presetOfStoredSession(storedHistory(undefined), 'missing')).toBeUndefined()
  })

  it('ignores a selection whose payload is not a preset id', async () => {
    const history = storedHistory({ id: 's', agentPreset: 'ptc', eventCount: 2 }, [selected(''), selected(7)])
    expect(await presetOfStoredSession(history, 's')).toBe('ptc')
  })
})

describe('sessionTitle malformed logs', () => {
  it('ignores a declared title that is not text and keeps looking', () => {
    const broken: StoredEvent = { type: 'session/title', data: { title: 7 } }
    expect(sessionTitle([broken, user('real prompt')])).toBe('real prompt')
  })

  it('ignores a prompt that normalizes to nothing and takes the next one', () => {
    // An injected block and a blank prompt both fail to name a session; the
    // first human prompt that survives normalization is the title.
    expect(sessionTitle([user('   '), user('real prompt')])).toBe('real prompt')
  })
})

/** A seam that records every slice read, so the head and tail order is observable. */
function recordingHistory(header: StoredHeader | undefined, events: readonly StoredEvent[]) {
  const reads: { readonly offset: number | undefined; readonly limit: number | undefined }[] = []
  const history: SessionHistory = {
    list: async () => [],
    header: async () => header,
    read: async (_id, options) => {
      reads.push({ offset: options?.offset, limit: options?.limit })
      return events.slice(options?.offset ?? 0, (options?.offset ?? 0) + (options?.limit ?? events.length))
    },
  }
  return { history, reads }
}

const stored = (eventCount: number | undefined): { id: string; cwd: undefined; createdAt: number; eventCount: number | undefined } =>
  ({ id: 's', cwd: undefined, createdAt: 0, eventCount })

describe('readSessionTitle', () => {
  const filler = Array.from({ length: TITLE_EVENT_LIMIT * 2 }, (_, index) => ({ type: 'turn/start', data: { turn: index } }))

  it('reads the tail first when the log is longer than the title window', async () => {
    const titled: StoredEvent = { type: 'session/title', data: { title: 'tail title' } }
    const { history, reads } = recordingHistory(undefined, [...filler, titled])

    // A title is latest-wins and usually written after the first turn, so the
    // tail is the read that pays; the head is not read when it already answered.
    expect(await readSessionTitle(history, stored(filler.length + 1))).toBe('tail title')
    expect(reads).toEqual([{ offset: filler.length + 1 - TITLE_EVENT_LIMIT, limit: TITLE_EVENT_LIMIT }])
  })

  it('falls back to the head when the tail holds no title yet', async () => {
    const { history, reads } = recordingHistory(undefined, [user('first prompt'), ...filler])

    expect(await readSessionTitle(history, stored(filler.length + 1))).toBe('first prompt')
    expect(reads).toEqual([
      { offset: filler.length + 1 - TITLE_EVENT_LIMIT, limit: TITLE_EVENT_LIMIT },
      { offset: undefined, limit: TITLE_EVENT_LIMIT },
    ])
  })

  it('reads only the head for a session that recorded no count', async () => {
    const { history, reads } = recordingHistory(undefined, [user('only prompt')])
    expect(await readSessionTitle(history, stored(undefined))).toBe('only prompt')
    expect(reads).toEqual([{ offset: undefined, limit: TITLE_EVENT_LIMIT }])
  })
})

describe('createSessionHistory', () => {
  const ctxWith = (service: unknown): Context => ({ get: () => service } as unknown as Context)
  const openable = { open: async () => ({ read: async () => ({ events: [] }), close: async () => {} }) }

  it('answers no history when the composition has no persistence service', () => {
    expect(createSessionHistory(ctxWith(undefined))).toBeUndefined()
    // The seam is optional and both calls are load-bearing: a service that can
    // list but cannot open a log cannot replay one either.
    expect(createSessionHistory(ctxWith({ list: async () => [] }))).toBeUndefined()
  })

  it('reads a slice through a handle it always closes', async () => {
    const closed: string[] = []
    const calls: (number | undefined)[][] = []
    const history = createSessionHistory(ctxWith({
      list: async () => [],
      open: async () => ({
        read: async (offset?: number, length?: number) => {
          calls.push([offset, length])
          return { events: [{ type: 'turn/start', data: { turn: 1 } }, { data: 'no type' }, 7] }
        },
        close: async () => {
          closed.push('s')
        },
      }),
    }))!

    expect(await history.read('s', { offset: 2, limit: 5 })).toEqual([{ type: 'turn/start', data: { turn: 1 } }])
    expect(calls).toEqual([[2, 5]])
    expect(closed).toEqual(['s'])
  })

  it('closes the handle even when the read fails', async () => {
    const closed: number[] = []
    const history = createSessionHistory(ctxWith({
      list: async () => [],
      open: async () => ({
        read: async () => {
          throw new Error('read-failed')
        },
        close: async () => {
          closed.push(1)
        },
      }),
    }))!

    // An unclosed handle keeps backend resources alive for the rest of the
    // process, so the failure path owes the close as much as the success one.
    await expect(history.read('s')).rejects.toThrow('read-failed')
    expect(closed).toEqual([1])
  })

  it('reads a header from the stat seam and answers none without one', async () => {
    const stats: string[] = []
    const history = createSessionHistory(ctxWith({
      ...openable,
      list: async () => [],
      stat: async (id: string) => {
        stats.push(id)
        return { header: { id, agentPreset: 'ptc', cwd: '/work', createdAt: 5 }, eventCount: 3 }
      },
    }))!
    expect(await history.header('s')).toEqual({ id: 's', agentPreset: 'ptc', eventCount: 3 })
    expect(stats).toEqual(['s'])

    const bare = createSessionHistory(ctxWith({ ...openable, list: async () => [] }))!
    expect(await bare.header('s')).toBeUndefined()
  })

  it('drops a snapshot with no usable identity or columns', async () => {
    const history = createSessionHistory(ctxWith({
      ...openable,
      list: async () => [
        7,
        { header: { cwd: '/work' } },
        { header: { id: 's', agentPreset: 7 }, eventCount: 'many' },
      ],
    }))!

    expect(await history.list(10)).toEqual([{ id: 's', cwd: undefined, createdAt: 0, eventCount: undefined }])
  })

  it('lists newest first, at most the limit the caller can afford', async () => {
    const history = createSessionHistory(ctxWith({
      ...openable,
      list: async () => [
        { header: { id: 'old', cwd: '/a', createdAt: 1 } },
        { header: { id: 'new', cwd: '/b', createdAt: 3 }, eventCount: 2 },
        { header: { id: 'mid', cwd: '/c', createdAt: 2 } },
      ],
    }))!

    expect(await history.list(2)).toEqual([
      { id: 'new', cwd: '/b', createdAt: 3, eventCount: 2 },
      { id: 'mid', cwd: '/c', createdAt: 2, eventCount: undefined },
    ])
  })

  it('answers an empty list for a service whose snapshot is not an array', async () => {
    const history = createSessionHistory(ctxWith({ ...openable, list: async () => undefined }))!
    expect(await history.list(10)).toEqual([])
  })
})

