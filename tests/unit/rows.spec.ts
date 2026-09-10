import { describe, expect, it } from 'vitest'
import { RowCache } from '@/ui/rows.ts'

describe('RowCache', () => {
  it('answers a repeated lookup without rebuilding the rows', () => {
    const cache = new RowCache()
    const key = {}
    expect(cache.lookup(key, '80')).toBeUndefined()
    cache.store(key, '80', ['row'])
    expect(cache.lookup(key, '80')).toEqual(['row'])
    expect(cache.stats()).toEqual({ hits: 1, misses: 1, size: 1 })
  })

  it('rebuilds when the tag changes, because the rows would differ', () => {
    const cache = new RowCache()
    const key = {}
    cache.store(key, '80|c-r', ['row'])
    expect(cache.lookup(key, '40|c-r')).toBeUndefined()
    expect(cache.stats().misses).toBe(1)
  })

  it('keys by entry identity, so two equal rows are still two entries', () => {
    const cache = new RowCache()
    cache.store({}, '80', ['a'])
    expect(cache.lookup({}, '80')).toBeUndefined()
  })

  it('stops growing at its limit and re-renders what it dropped', () => {
    const cache = new RowCache(2)
    const keys = [{}, {}, {}]
    keys.forEach((key, index) => cache.store(key, '80', [`row ${index}`]))
    expect(cache.stats().size).toBe(2)
    expect(cache.lookup(keys[0]!, '80')).toBeUndefined()
    expect(cache.lookup(keys[2]!, '80')).toEqual(['row 2'])
  })

  it('forgets everything when the transcript is cleared', () => {
    const cache = new RowCache()
    const key = {}
    cache.store(key, '80', ['row'])
    cache.clear()
    expect(cache.stats().size).toBe(0)
    expect(cache.lookup(key, '80')).toBeUndefined()
  })
})
