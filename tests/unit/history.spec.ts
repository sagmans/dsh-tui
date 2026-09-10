import { describe, expect, it } from 'vitest'
import { TITLE_CHAR_LIMIT, sessionTitle, type StoredEvent } from '@/agent/history.ts'

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

  it('reads past events that are not messages', () => {
    expect(sessionTitle([{ type: 'turn/start', data: { turn: 1 } }, user('hello')])).toBe('hello')
  })

  it('answers nothing for an empty log', () => {
    expect(sessionTitle([])).toBeUndefined()
  })
})
