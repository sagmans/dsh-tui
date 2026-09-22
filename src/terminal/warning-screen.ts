import { TuiAltScreen, type TuiStopOptions } from '@earendil-works/pi-tui'
import { holdHostWrites, HOST_WRITE_TARGETS, type HostWriteGuard } from './host-writes.ts'

const WARNING_EVENT = 'warning'
const RESTORE_SHELL = '\x1b[?1049l\x1b[0m\x1b[?7h\x1b[?25h'

/** Node's default warning listener writes outside the renderer, so delivery must wait for the shell. */
function deferWarnings(): () => void {
  const emit = process.emit
  const pending: unknown[][] = []
  let active = true
  const deferredEmit = function (this: NodeJS.Process, event: string | symbol, ...args: unknown[]): boolean {
    if (active && this === process && event === WARNING_EVENT) {
      pending.push(args)
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

  /** Told once when a frame could not be drawn, so the surface can report it. */
  onFrameError: ((error: unknown) => void) | undefined

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
      release?.()
      const writes = this.hostWrites
      this.hostWrites = undefined
      writes?.release()
    }
  }
}
