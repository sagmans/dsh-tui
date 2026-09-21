import { describe, expect, it } from 'vitest'
import { dshHomeDir, resolveStashPaths, sanitizeCwd, stashBaseDir } from '@/stash/paths.ts'

const LONG_SEGMENT = 'x'.repeat(300)
const DIGEST_PATTERN = /--[0-9a-f]{16}$/u

describe('sanitizeCwd', () => {
  it('flattens a path into a readable, versioned key', () => {
    expect(sanitizeCwd('/work/me/app')).toMatch(/^v1--work--me--app--[0-9a-f]{16}$/u)
    expect(sanitizeCwd('/')).toMatch(/^v1----[0-9a-f]{16}$/u)
  })

  it('escapes a percent, a backslash, and the separator so the label stays readable', () => {
    expect(sanitizeCwd('/a%b')).toContain('a%25b')
    expect(sanitizeCwd('/a\\b')).toContain('a%5Cb')
    // A literal "--" inside one segment must not read as two segments.
    expect(sanitizeCwd('/a--b')).toContain('a%2D%2Db')
  })

  /**
   * The separator is made of hyphens, so a hyphen in a directory name can always
   * be read as one: a key built from the label alone would give two directories
   * one bank, and each could then read or delete the other's drafts.
   */
  it('keeps paths apart when the label alone cannot', () => {
    expect(sanitizeCwd('/a-/b')).not.toBe(sanitizeCwd('/a/-b'))
    expect(sanitizeCwd('/a/b')).not.toBe(sanitizeCwd('/a-/b'))
    expect(sanitizeCwd('/a%2D%2Db')).not.toBe(sanitizeCwd('/a--b'))
  })

  it('keeps two long paths apart when only their tails differ', () => {
    const one = sanitizeCwd(`/work/${LONG_SEGMENT}/one`)
    const two = sanitizeCwd(`/work/${LONG_SEGMENT}/two`)
    expect(Buffer.byteLength(one)).toBeLessThanOrEqual(200)
    expect(Buffer.byteLength(two)).toBeLessThanOrEqual(200)
    expect(one).not.toBe(two)
    expect(one).toMatch(DIGEST_PATTERN)
  })

  it('keeps a truncated label from taking a name a shorter path could own', () => {
    const long = `/work/${LONG_SEGMENT}`
    const truncated = sanitizeCwd(long)
    // A directory whose own name is the truncated label is a different
    // directory, and must not find the long path's bank.
    expect(sanitizeCwd(`/${truncated.replace(/^v1--/u, '').replaceAll('--', '/')}`)).not.toBe(truncated)
  })

  it('stays within a filename for a path far past the limit', () => {
    const deep = `/${Array.from({ length: 60 }, (_, index) => `segment-${index}`).join('/')}`
    expect(Buffer.byteLength(sanitizeCwd(deep))).toBeLessThanOrEqual(200)
  })

  it('is stable for the same path, so a restart finds the same bank', () => {
    const long = `/work/${LONG_SEGMENT}/app`
    expect(sanitizeCwd(long)).toBe(sanitizeCwd(long))
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
  it('names the file after the cwd key and keeps the exact cwd beside it', () => {
    const paths = resolveStashPaths('/work/me/app', '/base')
    expect(paths.cwd).toBe('/work/me/app')
    expect(paths.key).toMatch(/^v1--work--me--app--[0-9a-f]{16}$/u)
    expect(paths.file).toBe(`/base/${paths.key}.json`)
  })

  it('gives two directories two files and one directory one file', () => {
    expect(resolveStashPaths('/a', '/base').file).not.toBe(resolveStashPaths('/b', '/base').file)
    expect(resolveStashPaths('/a', '/base').file).toBe(resolveStashPaths('/a', '/base').file)
    expect(resolveStashPaths('/a-/b', '/base').file).not.toBe(resolveStashPaths('/a/-b', '/base').file)
  })
})
