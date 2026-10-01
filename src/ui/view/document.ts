import { type TranscriptEntry, type TranscriptModel } from '../../transcript.ts'
import { SECOND_MS } from '../../transcript/tool-calls.ts'
import { type FrameRow } from '../frame.ts'
import { placeGap } from '../gap.ts'
import { RowCache } from '../rows.ts'
import { type ClickSpan } from '../view.ts'

/** Entry renderers keep presentation policy; this owner retains rows and their matching hit/copy accounts. */
export interface DocumentContext {
  readonly model: TranscriptModel
  readonly entryTag: (entry: TranscriptEntry, base: string) => string
  readonly clocked: (entry: TranscriptEntry) => boolean
  readonly renderEntry: (entry: TranscriptEntry, lines: string[], width: number, live: boolean, spans: ClickSpan[], copy: FrameRow[]) => void
}

interface DocumentFrame {
  readonly tag: string
  readonly revision: number
  readonly presentation: number
  readonly tick: number | undefined
  readonly lines: readonly string[]
}

/** Draft-only frames must not traverse history or format unchanged stream snapshots. */
export class TranscriptDocument {
  private readonly rows = new RowCache<TranscriptEntry>()
  private readonly entrySpans = new WeakMap<TranscriptEntry, readonly ClickSpan[]>()
  private readonly entryCopy = new WeakMap<TranscriptEntry, readonly FrameRow[]>()
  private frame: DocumentFrame | undefined
  private clickSpans: readonly ClickSpan[] = []
  private copied: readonly FrameRow[] = []

  constructor(private readonly context: DocumentContext) {}

  /** Clicks belong to the frame actually drawn, including cached entries and seam offsets. */
  get spans(): readonly ClickSpan[] {
    return this.clickSpans
  }

  /** Explicit restyling must rebuild both settled entries and the assembled document. */
  invalidate(): void {
    this.rows.clear()
    this.frame = undefined
  }

  /** History scans are needed only when content, presentation, or a displayed clock changes. */
  render(width: number, tag: string, presentation: number): readonly string[] {
    const revision = this.context.model.revision
    const tick = Math.floor(this.context.model.now() / SECOND_MS)
    const frame = this.frame
    if (frame !== undefined && frame.tag === tag && frame.revision === revision && frame.presentation === presentation
      && (frame.tick === undefined || frame.tick === tick)) return frame.lines

    const lines: string[] = []
    const spans: ClickSpan[] = []
    const copied: FrameRow[] = []
    const settled = this.context.model.settledCount()
    let clocked = false
    for (const [index, entry] of this.context.model.entries().entries()) {
      const start = lines.length
      const entryTag = this.context.entryTag(entry, tag)
      clocked ||= this.context.clocked(entry)
      const local: ClickSpan[] = []
      const copy: FrameRow[] = []
      const rows: string[] = []
      if (index >= settled) {
        // Only the current live frame survives; obsolete streaming prefixes never enter the settled cache.
        this.context.renderEntry(entry, rows, width, true, local, copy)
        copied.push(...copy)
      } else {
        const cached = this.rows.lookup(entry, entryTag)
        const saved = this.entrySpans.get(entry)
        const savedCopy = this.entryCopy.get(entry)
        if (cached !== undefined && saved !== undefined && savedCopy !== undefined) {
          rows.push(...cached)
          local.push(...saved)
          copied.push(...savedCopy)
        } else {
          this.context.renderEntry(entry, rows, width, false, local, copy)
          this.rows.store(entry, entryTag, rows)
          this.entrySpans.set(entry, local)
          this.entryCopy.set(entry, copy)
          copied.push(...copy)
        }
      }
      // Seam air changes row offsets, so hit spans follow placement rather than cached local coordinates.
      const base = start - placeGap(lines, rows)
      for (const span of local) spans.push({ ...span, start: span.start + base, end: span.end + base })
    }
    this.clickSpans = spans
    this.copied = copied
    // Component's mutable return type must not let a borrower corrupt cached rows and their hit/copy accounts.
    Object.freeze(lines)
    this.frame = { tag, revision, presentation, tick: clocked ? tick : undefined, lines }
    return lines
  }

  /** Frame metadata must remain paired with the retained rows, including live message copies. */
  copyRows(): readonly FrameRow[] {
    return this.copied
  }
}
