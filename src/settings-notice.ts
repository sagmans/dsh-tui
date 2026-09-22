/** Where a deferred notice prints once the surface owns the screen. */
export type NoticeSink = (message: string) => void

/** A notice that waits until the surface can show it. */
export interface DeferredNotice {
  /** Print through `sink` from now on, starting with anything held back. */
  open(sink: NoticeSink): void
  /** Print the notice now, or hold it until {@link DeferredNotice.open}. */
  post(message: string): void
}

/**
 * Hold a notice found before the alternate screen exists.
 *
 * The settings scope applies on its own schedule, so a section refused at boot
 * is read either before the surface owns the screen or after it: one holder,
 * opened when the screen is taken, keeps both orders honest — and a notice
 * written to stderr alone would have been buried under the alternate screen.
 *
 * Everything held is printed, not just the last: a boot can find several things
 * wrong at once — a refused section and the themes beside it — and showing one of
 * them would leave the reader fixing what they were told about while the rest
 * waited for a restart.
 */
export function createDeferredNotice(): DeferredNotice {
  let sink: NoticeSink | undefined
  const held: string[] = []
  return {
    open(next) {
      sink = next
      for (const message of held.splice(0)) next(message)
    },
    post(message) {
      if (sink === undefined) {
        held.push(message)
        return
      }
      sink(message)
    },
  }
}
