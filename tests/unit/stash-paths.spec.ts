import { describe, expect, it } from 'vitest'
import { dshHomeDir, resolveStashPaths, sanitizeSessionId, stashBaseDir } from '@/stash/paths.ts'

const LONG_ID = 'x'.repeat(300)
const DIGEST_PATTERN = /--[0-9a-f]{16}$/u
/** A stand-in OS home, so the resolver is driven without touching the process. */
const TEST_HOME = '/home/me'
const FALLBACK_HOME = `${TEST_HOME}/.dsh`

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
    // An id made of many segments has to fit the same filename budget as one long
    // segment, so the key stays openable however the id is shaped.
    const segmented = sanitizeSessionId(
      `tui-session-${Array.from({ length: 60 }, (_, index) => `part-${index}`).join('/')}`,
    )
    for (const key of [one, two, segmented]) expect(Buffer.byteLength(key)).toBeLessThanOrEqual(200)
    expect(one).not.toBe(two)
    expect(one).toMatch(DIGEST_PATTERN)
  })
})

describe('DSH_HOME resolution', () => {
  it('uses the configured home, and only falls back when it names nothing', () => {
    expect(dshHomeDir({ DSH_HOME: '/scratch/dsh' }, TEST_HOME)).toBe('/scratch/dsh')
    expect(dshHomeDir({ DSH_HOME: '  /scratch/dsh  ' }, TEST_HOME)).toBe('/scratch/dsh')
    expect(dshHomeDir({}, TEST_HOME)).toBe(FALLBACK_HOME)
    expect(dshHomeDir({ DSH_HOME: '   ' }, TEST_HOME)).toBe(FALLBACK_HOME)
  })

  /**
   * The stash bank, the theme files, and the prompt history all read the harness
   * home from here, so one spelling of `~` has to name one directory for all
   * three. `~user` and an interior `~` are ordinary path text everywhere but a
   * shell, and rewriting them would move a directory the reader named exactly.
   */
  it.each([
    ['~', TEST_HOME],
    ['~/harness', `${TEST_HOME}/harness`],
    ['~root/harness', '~root/harness'],
    ['/scratch/~/keep', '/scratch/~/keep'],
  ])('expands only the spellings that name the OS home: %s', (configured, expected) => {
    expect(dshHomeDir({ DSH_HOME: configured }, TEST_HOME)).toBe(expected)
  })

  it('keeps the value as written when the environment names no home to expand', () => {
    expect(dshHomeDir({ DSH_HOME: '~' }, '')).toBe('~')
  })

  it('keeps the stash under a directory this surface owns', () => {
    expect(stashBaseDir({ DSH_HOME: '/scratch/dsh' }, TEST_HOME)).toBe('/scratch/dsh/tui-stash')
    expect(stashBaseDir({ DSH_HOME: '~/harness' }, TEST_HOME)).toBe(`${TEST_HOME}/harness/tui-stash`)
  })
})

describe('resolveStashPaths', () => {
  it('names the file after the session key and keeps the exact id beside it', () => {
    const paths = resolveStashPaths('tui-session-abc', '/base')
    expect(paths.sessionId).toBe('tui-session-abc')
    expect(paths.key).toMatch(/^v2--tui-session-abc--[0-9a-f]{16}$/u)
    expect(paths.file).toBe(`/base/${paths.key}.json`)
  })

  it('keeps path banks separate from session banks even when their identifiers match', () => {
    const directory = '/worktree/project'
    const pathBank = resolveStashPaths(directory, '/base', 'path')
    expect(pathBank.file).not.toBe(resolveStashPaths(directory, '/base', 'session').file)
    expect(pathBank.file).toBe(resolveStashPaths(directory, '/base', 'path').file)
    expect(pathBank.file).not.toBe(resolveStashPaths('/worktree/other', '/base', 'path').file)
    expect(pathBank.key).toMatch(/^v3--/u)
  })

  it('gives two sessions two files and one session one file', () => {
    expect(resolveStashPaths('a', '/base').file).not.toBe(resolveStashPaths('b', '/base').file)
    expect(resolveStashPaths('a', '/base').file).toBe(resolveStashPaths('a', '/base').file)
    expect(resolveStashPaths('a-/b', '/base').file).not.toBe(resolveStashPaths('a/-b', '/base').file)
  })
})
