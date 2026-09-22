import { describe, expect, it } from 'vitest'
import { RowCache } from '@/ui/rows.ts'

describe('RowCache', () => {
  it('answers a repeated lookup without rebuilding the rows', () => {
    const cache = new RowCache()
    const key = {}
    expect(cache.lookup(key, '80')).toBeUndefined()
    cache.store(key, '80', ['row'])
    expect(cache.lookup(key, '80')).toEqual(['row'])
    expect(cache.stats()).toEqual({ hits: 1, misses: 1 })
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

  it('keeps every settled row for as long as its entry lives', () => {
    // A repaint measures every entry, so a store bounded below the transcript
    // would evict the very row the next pass needs; a longer transcript than any
    // bound the cache could carry must still be free on the second pass.
    const cache = new RowCache()
    const entries = Array.from({ length: 5_000 }, () => ({}))
    for (const entry of entries) cache.store(entry, '80', ['row'])
    for (const entry of entries) expect(cache.lookup(entry, '80')).toEqual(['row'])
    expect(cache.stats()).toEqual({ hits: 5_000, misses: 0 })
  })

  it('forgets everything when the transcript is cleared', () => {
    const cache = new RowCache()
    const key = {}
    cache.store(key, '80', ['row'])
    cache.clear()
    expect(cache.lookup(key, '80')).toBeUndefined()
  })
})
