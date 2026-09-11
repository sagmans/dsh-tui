/**
 * Rendered transcript rows, kept per entry.
 *
 * A repaint walks the whole transcript, and wrapping text is the expensive part
 * of doing that: without a cache, a session with a few thousand rows re-wraps
 * all of them on every keystroke. Entries are stable objects, so their rows can
 * be keyed by identity and only rebuilt when the width or the reader's
 * expansion state changes.
 */

/** Entries kept before the oldest are re-rendered on demand. */
export const ROW_CACHE_LIMIT = 4_000

interface CachedRows {
  readonly tag: string
  readonly lines: readonly string[]
}

/** What the cache has done, so a test can assert the work was actually avoided. */
export interface RowCacheStats {
  readonly hits: number
  readonly misses: number
  readonly size: number
}

export class RowCache<K extends object = object> {
  private readonly rows = new Map<K, CachedRows>()
  private hits = 0
  private misses = 0

  constructor(private readonly limit: number = ROW_CACHE_LIMIT) {}

  /** The rows for a key and tag, or nothing when they have to be rebuilt. */
  lookup(key: K, tag: string): readonly string[] | undefined {
    const cached = this.rows.get(key)
    if (cached === undefined || cached.tag !== tag) {
      this.misses += 1
      return undefined
    }
    this.hits += 1
    // Reinserting keeps a row that is still on screen from ageing out.
    this.rows.delete(key)
    this.rows.set(key, cached)
    return cached.lines
  }

  store(key: K, tag: string, lines: readonly string[]): void {
    this.rows.set(key, { tag, lines })
    while (this.rows.size > this.limit) {
      const oldest = this.rows.keys().next()
      if (oldest.done === true) return
      this.rows.delete(oldest.value)
    }
  }

  clear(): void {
    this.rows.clear()
  }

  stats(): RowCacheStats {
    return { hits: this.hits, misses: this.misses, size: this.rows.size }
  }
}
