/**
 * Restore the terminal when the process is asked to end from outside.
 *
 * The surface owns the alternate screen and nothing else puts it back: a SIGTERM
 * from a supervisor, a SIGHUP when a window closes, or a SIGQUIT all end a
 * process by default, leaving the reader on a screen no shell prompt is drawn
 * in. These handlers run the same shutdown a quit key runs, then leave with the
 * status a shell reports for the signal.
 */

/** Signals whose default action ends the process without unwinding the surface. */
export const TERMINATING_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const

export type TerminatingSignal = (typeof TERMINATING_SIGNALS)[number]

/** The status a shell reports for a process ended by one of those signals. */
const SIGNAL_EXIT: Record<TerminatingSignal, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129, SIGQUIT: 131 }

/**
 * Run a shutdown once for the first terminating signal, then leave.
 *
 * The listener removes itself before the shutdown runs, so a slow shutdown
 * cannot be re-entered by a second signal; the status is the one a shell expects
 * for the signal, so whatever was supervising the process sees an interrupted
 * run rather than a clean one.
 */
export function installSignalRestore(options: {
  shutdown(code: number, signal: TerminatingSignal): void
  signals?: readonly TerminatingSignal[]
}): () => void {
  const handlers = new Map<TerminatingSignal, () => void>()
  const remove = (): void => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler)
    handlers.clear()
  }
  for (const signal of options.signals ?? TERMINATING_SIGNALS) {
    const handler = (): void => {
      remove()
      options.shutdown(SIGNAL_EXIT[signal], signal)
    }
    process.on(signal, handler)
    handlers.set(signal, handler)
  }
  return remove
}
