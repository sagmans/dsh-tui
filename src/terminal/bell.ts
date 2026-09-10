/**
 * The terminal bell.
 *
 * A bell is a courtesy for the turn the reader walked away from, and noise for
 * every other one, so it is bound to how long the turn ran and can be turned
 * off entirely.
 */

/** The terminal bell character. */
export const BELL = '\u0007'

/** How long a turn has to run before its end is worth a bell. */
export const BELL_AFTER_MS = 10_000

/** Whether this turn's end should ring. */
export function shouldRingBell(input: {
  readonly bell: boolean
  readonly ranForMs: number
  readonly exiting: boolean
}): boolean {
  return input.bell && !input.exiting && input.ranForMs >= BELL_AFTER_MS
}
