import { Buffer } from 'node:buffer'
import { TuiAltScreen, type TuiAltScreenOptions, type Terminal, type TuiStopOptions } from '@earendil-works/pi-tui'
import { holdHostWrites, HOST_WRITE_LIMIT, HOST_WRITE_TARGETS, type HostWriteGuard } from './host-writes.ts'

const WARNING_EVENT = 'warning'
const WARNING_EVENT_LIMIT = 256
const WARNING_TEXT_FIELDS = ['name', 'message', 'stack', 'code', 'detail']
const WARNING_DROPPED = '… warnings dropped'
const RESTORE_SHELL = '\x1b[?1049l\x1b[0m\x1b[?7h\x1b[?25h'

/** Budget standard warning text without replacing the producer's retained event identity. */
function warningBytes(args: readonly unknown[]): number {
  let bytes = 0
  try {
    for (const argument of args) {
      const values = argument instanceof Error
        ? WARNING_TEXT_FIELDS.map(field => Reflect.get(argument, field))
        : [argument]
      for (const value of values) {
        if ((value !== null && typeof value === 'object') || typeof value === 'function') return HOST_WRITE_LIMIT + 1
        if (value !== undefined) bytes += Buffer.byteLength(String(value))
        if (bytes > HOST_WRITE_LIMIT) return bytes
      }
    }
  } catch {
    // Opaque metadata or throwing getters cannot establish a safe retention budget.
    return HOST_WRITE_LIMIT + 1
  }
  return bytes
}

/** Node's default warning listener writes outside the renderer, so delivery must wait for the shell. */
function deferWarnings(): () => void {
  const emit = process.emit
  const pending: unknown[][] = []
  let bytes = 0
  let dropped = 0
  let active = true
  const deferredEmit = function (this: NodeJS.Process, event: string | symbol, ...args: unknown[]): boolean {
    if (active && this === process && event === WARNING_EVENT) {
      // Root-cause warnings survive a burst; later repetitions must not grow the hold or repeatedly format stacks.
      if (pending.length >= WARNING_EVENT_LIMIT || bytes >= HOST_WRITE_LIMIT) dropped += 1
      else {
        const size = warningBytes(args)
        if (size > HOST_WRITE_LIMIT - bytes) dropped += 1
        else {
          pending.push(args)
          bytes += size
        }
      }
      return process.listenerCount(WARNING_EVENT) > 0
    }
    return Reflect.apply(emit, this, [event, ...args]) as boolean
  } as typeof process.emit
  process.emit = deferredEmit
  return () => {
    if (!active) return
    active = false
    // A later wrapper may own the slot; its retained reference must become a pass-through instead.
    if (process.emit === deferredEmit) process.emit = emit
    const failures: unknown[] = []
    bytes = 0
    if (dropped > 0) {
      try {
        Reflect.apply(emit, process, [WARNING_EVENT, new Error(`${WARNING_DROPPED} (${dropped} warnings)`)])
      } catch (error) {
        failures.push(error)
      }
    }
    for (const args of pending.splice(0)) {
      try {
        Reflect.apply(emit, process, [WARNING_EVENT, ...args])
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) throw failures[0]
  }
}

/**
 * Terminal safety follows screen ownership, including partial startup and
 * repeated disposal: warnings wait for the shell, the host's own writing waits
 * with them, and a frame that cannot be drawn keeps the last good screen.
 */
export class WarningSafeTui extends TuiAltScreen {
  private releaseWarnings: (() => void) | undefined
  private hostWrites: HostWriteGuard | undefined
  private frameFailed = false

  /** Each failure episode deserves a report, but repeated retries must not flood the surface. */
  onFrameError: ((error: unknown) => void) | undefined

  /**
   * The screen as this surface runs it, with the framework's other two parameters
   * out of the way: the terminal keeps its own hardware cursor and the surface
   * writes no drawing log of its own, so the options are the only thing a caller
   * ever has to name.
   */
  constructor(terminal: Terminal, options?: TuiAltScreenOptions) {
    super(terminal, undefined, undefined, options)
  }

  override start(): void {
    this.releaseWarnings ??= deferWarnings()
    this.hostWrites ??= holdHostWrites({ terminal: this.terminal, targets: HOST_WRITE_TARGETS })
    try {
      super.start()
    } catch (error) {
      this.stop({ preserveScreen: true })
      throw error
    }
  }

  /**
   * Draw a frame, keeping the last good one when drawing fails.
   *
   * A frame is composed before it is written, so a component that throws leaves
   * the previous screen intact; without this the throw would reach the timer that
   * asked for the frame, end the process, and take the terminal down with it.
   * The first failure is reported and later ones stay silent: a repaint a broken
   * component fails again is the same news, and repeating it would only loop.
   */
  override doRender(): void {
    try {
      super.doRender()
      this.frameFailed = false
    } catch (error) {
      if (this.frameFailed) return
      this.frameFailed = true
      this.onFrameError?.(error)
    }
  }

  override stop(options?: TuiStopOptions): void {
    try {
      super.stop(options)
    } catch (error) {
      // Rendering the final transcript can fail before pi-tui writes its alternate-screen exit.
      this.terminal.write(RESTORE_SHELL)
      throw error
    } finally {
      // Warnings go first, while the hold is still in place, so what they print
      // joins the host text in the order it arrived; the release then writes it
      // all out behind the exit sequence this call already wrote.
      const release = this.releaseWarnings
      this.releaseWarnings = undefined
      let warningFailure: { readonly error: unknown } | undefined
      try {
        release?.()
      } catch (error) {
        // A listener that throws must not strand the host's own writing: the
        // hold below is the terminal's, and it goes back on every path out of
        // stop() — only then is the listener's failure surfaced again.
        warningFailure = { error }
      }
      const writes = this.hostWrites
      this.hostWrites = undefined
      writes?.release()
      if (warningFailure !== undefined) throw warningFailure.error
    }
  }
}
