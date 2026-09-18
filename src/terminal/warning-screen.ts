import { TuiAltScreen, type TuiStopOptions } from '@earendil-works/pi-tui'

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

/** Warning ownership follows screen ownership, including partial startup and repeated disposal. */
export class WarningSafeTui extends TuiAltScreen {
  private releaseWarnings: (() => void) | undefined

  override start(): void {
    this.releaseWarnings ??= deferWarnings()
    try {
      super.start()
    } catch (error) {
      this.stop({ preserveScreen: true })
      throw error
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
      const release = this.releaseWarnings
      this.releaseWarnings = undefined
      release?.()
    }
  }
}
