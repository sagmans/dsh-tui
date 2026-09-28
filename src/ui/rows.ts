/**
 * Rendered transcript rows, kept per entry.
 *
 * A repaint walks the whole transcript, and wrapping text is the expensive part
 * of doing that: without a cache, a session with a few thousand rows re-wraps
 * all of them on every keystroke. Entries are stable objects, so their rows can
 * be keyed by identity and only rebuilt when the width or the reader's
 * expansion state changes.
 *
 * The store is weak because the transcript itself is the working set: a repaint
 * measures every entry, so a fixed bound smaller than the entry count would
 * evict exactly the row the next pass is about to need and turn every repaint
 * into a full re-wrap. Tying cached rows to the entry's own lifetime keeps a
 * settled row exactly as long as the entry exists, and releases it with the
 * entry when a session is dropped or the model is reset.
 */

interface CachedRows {
  readonly tag: string
  readonly lines: readonly string[]
}

export class RowCache<K extends object = object> {
  private rows = new WeakMap<K, CachedRows>()

  /** The rows for a key and tag, or nothing when they have to be rebuilt. */
  lookup(key: K, tag: string): readonly string[] | undefined {
    const cached = this.rows.get(key)
    if (cached === undefined || cached.tag !== tag) return undefined
    return cached.lines
  }

  store(key: K, tag: string, lines: readonly string[]): void {
    this.rows.set(key, { tag, lines })
  }

  clear(): void {
    this.rows = new WeakMap()
  }
}
