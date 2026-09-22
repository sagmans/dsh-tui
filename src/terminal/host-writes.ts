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

/** How deep the surface currently is inside a call on the terminal object. */
interface SurfaceCall {
  depth: number
}

/**
 * Mark every call on the terminal object as the surface's own, whatever method it is.
 *
 * A real terminal writes part of its protocol straight to the stream: the
 * keyboard-protocol query, the bracketed-paste toggle, and the cursor moves all
 * bypass the terminal's own `write`, so watching only `write` defers them to
 * release — after the screen is gone, where the shell answers a query the
 * surface no longer reads. A method that can suspend is left unmarked, because
 * the mark would outlive its synchronous call and let host output through while
 * it waits.
 */
function markTerminalCalls(terminal: HostWritable, call: SurfaceCall): () => void {
  const keys = new Set<string | symbol>()
  for (let holder: object | null = terminal; holder !== null && holder !== Object.prototype; holder = Object.getPrototypeOf(holder) as object | null) {
    for (const key of Reflect.ownKeys(holder)) {
      if (key === 'constructor') continue
      const descriptor = Object.getOwnPropertyDescriptor(holder, key)
      if (descriptor !== undefined && typeof descriptor.value === 'function') keys.add(key)
    }
  }
  const own = new Map<string | symbol, PropertyDescriptor | undefined>()
  for (const key of keys) {
    const method = (terminal as unknown as Record<string | symbol, unknown>)[key]
    if (typeof method !== 'function' || Object.getPrototypeOf(method)?.constructor?.name !== 'Function') continue
    const before = Object.getOwnPropertyDescriptor(terminal, key)
    if (before !== undefined && !before.configurable && !before.writable) continue
    own.set(key, before)
    const wrapped = function (this: unknown, ...args: unknown[]): unknown {
      call.depth += 1
      try {
        return Reflect.apply(method, this, args)
      } finally {
        call.depth -= 1
      }
    }
    Object.defineProperty(terminal, key, {
      configurable: before?.configurable ?? true,
      enumerable: before?.enumerable ?? false,
      writable: before?.writable ?? true,
      value: wrapped,
    })
  }
  return () => {
    for (const [key, before] of own) {
      if (before === undefined) delete (terminal as unknown as Record<string | symbol, unknown>)[key]
      else Object.defineProperty(terminal, key, before)
    }
    own.clear()
  }
}

export function holdHostWrites(options: HostWriteOptions): HostWriteGuard {
  const limit = options.limit ?? HOST_WRITE_LIMIT
  const held = new Map<HostWritable, HeldWrites>()
  for (const target of options.targets) held.set(target, { chunks: [], length: 0, dropped: 0 })
  const surface: SurfaceCall = { depth: 0 }
  const restoreTerminal = markTerminalCalls(options.terminal, surface)
  const streams = options.targets.map(target => holdStream(target, held.get(target)!, () => surface.depth > 0, limit))
  let active = true
  return {
    release() {
      if (!active) return
      active = false
      restoreTerminal()
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
