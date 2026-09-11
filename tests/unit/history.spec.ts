import { describe, expect, it } from 'vitest'
import {
  PRESET_EVENT_LIMIT,
  TITLE_CHAR_LIMIT,
  presetOfStoredSession,
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
    expect(sessionTitle([{ type: 'session/title', data: { title: '   ' } }, user('first prompt')])).toBe('first prompt')
  })

  it('reads past events that are not messages', () => {
    expect(sessionTitle([{ type: 'turn/start', data: { turn: 1 } }, user('hello')])).toBe('hello')
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
    const history = storedHistory({ id: 's', agentPreset: 'ptc', eventCount: 2 })
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

  it('keeps the header when a long log recorded no selection', async () => {
    const filler = Array.from({ length: PRESET_EVENT_LIMIT * 3 }, () => ({ type: 'turn/start', data: {} }))
    const history = storedHistory({ id: 's', agentPreset: 'minimal', eventCount: filler.length }, filler)
    expect(await presetOfStoredSession(history, 's')).toBe('minimal')
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
