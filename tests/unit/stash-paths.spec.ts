import { describe, expect, it } from 'vitest'
import { dshHomeDir, resolveStashPaths, sanitizeCwd, stashBaseDir } from '@/stash/paths.ts'

const LONG_SEGMENT = 'x'.repeat(300)

describe('sanitizeCwd', () => {
  it('flattens a path into a readable, versioned key', () => {
    expect(sanitizeCwd('/work/me/app')).toBe('v1--work--me--app')
    expect(sanitizeCwd('/')).toBe('v1--')
  })

  it('escapes a percent, a backslash, and the separator so distinct paths stay distinct', () => {
    expect(sanitizeCwd('/a%b')).toBe('v1--a%25b')
    expect(sanitizeCwd('/a\\b')).toBe('v1--a%5Cb')
    // A literal "--" inside one segment must not read as two segments.
    expect(sanitizeCwd('/a--b')).not.toBe(sanitizeCwd('/a/b'))
    expect(sanitizeCwd('/a--b')).toBe('v1--a%2D%2Db')
    expect(sanitizeCwd('/a%2D%2Db')).not.toBe(sanitizeCwd('/a--b'))
  })

  it('keeps two long paths apart with a hash of the whole path', () => {
    const one = sanitizeCwd(`/work/${LONG_SEGMENT}/one`)
    const two = sanitizeCwd(`/work/${LONG_SEGMENT}/two`)
    expect(Buffer.byteLength(one)).toBeLessThanOrEqual(200)
    expect(Buffer.byteLength(two)).toBeLessThanOrEqual(200)
    expect(one).not.toBe(two)
    expect(one).toMatch(/[0-9a-f]{16}$/u)
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
  it('names the file after the cwd key', () => {
    const paths = resolveStashPaths('/work/me/app', '/base')
    expect(paths.key).toBe('v1--work--me--app')
    expect(paths.file).toBe('/base/v1--work--me--app.json')
  })

  it('gives two directories two files and one directory one file', () => {
    expect(resolveStashPaths('/a', '/base').file).not.toBe(resolveStashPaths('/b', '/base').file)
    expect(resolveStashPaths('/a', '/base').file).toBe(resolveStashPaths('/a', '/base').file)
  })
})
