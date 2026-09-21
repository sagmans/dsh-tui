import { describe, expect, it } from 'vitest'
import { dshHomeDir, resolveStashPaths, sanitizeSessionId, stashBaseDir } from '@/stash/paths.ts'

const LONG_ID = 'x'.repeat(300)
const DIGEST_PATTERN = /--[0-9a-f]{16}$/u

describe('sanitizeSessionId', () => {
  it('flattens a session id into a readable, versioned key', () => {
    expect(sanitizeSessionId('tui-session-abc')).toMatch(/^v2--tui-session-abc--[0-9a-f]{16}$/u)
    expect(sanitizeSessionId('')).toMatch(/^v2----[0-9a-f]{16}$/u)
  })

  it('escapes a percent, a backslash, and the separator so the label stays readable', () => {
    expect(sanitizeSessionId('a%b')).toContain('a%25b')
    expect(sanitizeSessionId('a\\b')).toContain('a%5Cb')
    // A literal "--" inside one segment must not read as two segments.
    expect(sanitizeSessionId('a--b')).toContain('a%2D%2Db')
  })

  /**
   * The separator is made of hyphens, so a hyphen in a session id can always be
   * read as one: a key built from the label alone would give two sessions one
   * bank, and each could then read or delete the other's drafts.
   */
  it('keeps ids apart when the label alone cannot', () => {
    expect(sanitizeSessionId('a-/b')).not.toBe(sanitizeSessionId('a/-b'))
    expect(sanitizeSessionId('a/b')).not.toBe(sanitizeSessionId('a-/b'))
    expect(sanitizeSessionId('a%2D%2Db')).not.toBe(sanitizeSessionId('a--b'))
  })

  it('keeps two long ids apart when only their tails differ', () => {
    const one = sanitizeSessionId(`tui-session-${LONG_ID}-one`)
    const two = sanitizeSessionId(`tui-session-${LONG_ID}-two`)
    expect(Buffer.byteLength(one)).toBeLessThanOrEqual(200)
    expect(Buffer.byteLength(two)).toBeLessThanOrEqual(200)
    expect(one).not.toBe(two)
    expect(one).toMatch(DIGEST_PATTERN)
  })

  it('keeps a truncated label from taking a name a shorter id could own', () => {
    const long = `tui-session-${LONG_ID}`
    const truncated = sanitizeSessionId(long)
    // A session whose own id is the truncated label is a different session, and
    // must not find the long id's bank.
    expect(sanitizeSessionId(truncated.replace(/^v2--/u, '').replaceAll('--', '/'))).not.toBe(truncated)
  })

  it('stays within a filename for an id far past the limit', () => {
    const long = `tui-session-${Array.from({ length: 60 }, (_, index) => `part-${index}`).join('/')}`
    expect(Buffer.byteLength(sanitizeSessionId(long))).toBeLessThanOrEqual(200)
  })

  it('is stable for the same session, so a resume finds the same bank', () => {
    expect(sanitizeSessionId('tui-session-abc')).toBe(sanitizeSessionId('tui-session-abc'))
  })
})

describe('DSH_HOME resolution', () => {
  it('uses the configured home, and only falls back when it names nothing', () => {
    expect(dshHomeDir({ DSH_HOME: '/scratch/dsh' }, '/home/me')).toBe('/scratch/dsh')
    expect(dshHomeDir({ DSH_HOME: '  /scratch/dsh  ' }, '/home/me')).toBe('/scratch/dsh')
    expect(dshHomeDir({}, '/home/me')).toBe('/home/me/.dsh')
    expect(dshHomeDir({ DSH_HOME: '   ' }, '/home/me')).toBe('/home/me/.dsh')
  })

  it('keeps the stash under a directory this surface owns', () => {
    expect(stashBaseDir({ DSH_HOME: '/scratch/dsh' }, '/home/me')).toBe('/scratch/dsh/tui-stash')
  })
})

describe('resolveStashPaths', () => {
  it('names the file after the session key and keeps the exact id beside it', () => {
    const paths = resolveStashPaths('tui-session-abc', '/base')
    expect(paths.sessionId).toBe('tui-session-abc')
    expect(paths.key).toMatch(/^v2--tui-session-abc--[0-9a-f]{16}$/u)
    expect(paths.file).toBe(`/base/${paths.key}.json`)
  })

  it('gives two sessions two files and one session one file', () => {
    expect(resolveStashPaths('a', '/base').file).not.toBe(resolveStashPaths('b', '/base').file)
    expect(resolveStashPaths('a', '/base').file).toBe(resolveStashPaths('a', '/base').file)
    expect(resolveStashPaths('a-/b', '/base').file).not.toBe(resolveStashPaths('a/-b', '/base').file)
  })
})
