import { Buffer } from 'node:buffer'

/**
 * Keep the host's own writing off a screen the surface owns.
 *
 * The alternate screen is painted from a buffer the surface keeps, so text that
 * arrives between frames is drawn over a frame the surface then believes is
 * already on screen: the damage is skipped as unchanged and stays until
 * something forces a full repaint. Warnings are deferred separately; this is the
 * channel a library, a stray `console.log`, or an unhandled rejection report
 * writes to directly. Text is held until the screen is given back, then written
 * in the order it arrived, so a reader still gets the diagnostics — after the
 * frame they would otherwise have ruined.
 *
 * The surface's own drawing goes through the terminal object, which is wrapped
 * here: a write made inside that call passes through, and everything else waits.
 */

/** One stream a host may write to without asking the surface. */
export interface HostWritable {
  write(...args: unknown[]): unknown
}

/** How much host text one stream may hold before the oldest is dropped. */
export const HOST_WRITE_LIMIT = 64 * 1024

/** What a reader is told when the held text had to be trimmed. */
export const HOST_WRITE_DROPPED = '… host output dropped'

/** The streams a host reaches for when it writes without the surface's help. */
export const HOST_WRITE_TARGETS: readonly HostWritable[] = [process.stdout, process.stderr]

export interface HostWriteGuard {
  /** Stop holding: later writes pass, and everything held is written out. */
  release(): void
}

export interface HostWriteOptions {
  /** The channel the surface draws through; a write inside it must pass through. */
  terminal: HostWritable
  /** The streams the host writes to directly. */
  targets: readonly HostWritable[]
  /** Per-stream hold budget; the oldest text is dropped past it. */
  limit?: number
}

/** One stream's held text, and how much of it had to be dropped. */
interface HeldWrites {
  readonly chunks: string[]
  length: number
  dropped: number
}

/** The original write of one held stream, so release can write through it. */
interface HeldStream {
  readonly restore: () => void
  readonly original: (...args: unknown[]) => unknown
}

/**
 * Replace a stream's write with one that holds text until release.
 *
 * The original is restored exactly as it was found — an own property stays an own
 * property, an inherited one disappears again — so a host that patched the
 * stream before this ran keeps its own seam.
 */
function holdStream(target: HostWritable, held: HeldWrites, isSurfaceWrite: () => boolean, limit: number): HeldStream {
  const own = Object.getOwnPropertyDescriptor(target, 'write')
  const original = target.write
  target.write = function (this: unknown, ...args: unknown[]): unknown {
    if (isSurfaceWrite()) return Reflect.apply(original, this, args)
    const [chunk, encoding, callback] = args
    const text = typeof chunk === 'string'
      ? chunk
      : chunk instanceof Uint8Array
        ? Buffer.from(chunk).toString('utf8')
        : String(chunk)
    held.chunks.push(text)
    held.length += text.length
    while (held.length > limit && held.chunks.length > 1) {
      held.length -= held.chunks.shift()?.length ?? 0
      held.dropped += 1
    }
    if (typeof encoding === 'function') encoding()
    else if (typeof callback === 'function') callback()
    return true
  }
  return {
    original: (...args: unknown[]) => Reflect.apply(original, target, args),
    restore: () => {
      if (own === undefined) delete (target as { write?: unknown }).write
      else Object.defineProperty(target, 'write', own)
    },
  }
}

export function holdHostWrites(options: HostWriteOptions): HostWriteGuard {
  const limit = options.limit ?? HOST_WRITE_LIMIT
  const held = new Map<HostWritable, HeldWrites>()
  for (const target of options.targets) held.set(target, { chunks: [], length: 0, dropped: 0 })
  let surfaceWriting = false
  const terminalOwn = Object.getOwnPropertyDescriptor(options.terminal, 'write')
  const terminalWrite = options.terminal.write
  options.terminal.write = function (this: unknown, ...args: unknown[]): unknown {
    // The flag is synchronous by construction: a frame is composed and written
    // without yielding, so no host write can observe it set.
    surfaceWriting = true
    try {
      return Reflect.apply(terminalWrite, this, args)
    } finally {
      surfaceWriting = false
    }
  }
  const streams = options.targets.map(target => holdStream(target, held.get(target)!, () => surfaceWriting, limit))
  let active = true
  return {
    release() {
      if (!active) return
      active = false
      if (terminalOwn === undefined) delete (options.terminal as { write?: unknown }).write
      else Object.defineProperty(options.terminal, 'write', terminalOwn)
      for (const stream of streams) stream.restore()
      for (const [index, target] of options.targets.entries()) {
        const writes = held.get(target)
        if (writes === undefined || (writes.chunks.length === 0 && writes.dropped === 0)) continue
        const notice = writes.dropped === 0 ? '' : `${HOST_WRITE_DROPPED} (${writes.dropped} writes)\n`
        streams[index]?.original(notice + writes.chunks.join(''))
        writes.chunks.length = 0
        writes.length = 0
        writes.dropped = 0
      }
    },
  }
}
