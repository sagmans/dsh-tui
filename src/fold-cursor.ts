import type { ForkEvent } from './agent/fork.ts'

/**
 * The fold's place in a session's durable event sequence.
 *
 * A resumed session is folded while its agent's loop is already live, so the
 * same event reaches the surface twice: once on the stream, once from the log
 * the fold is reading. Every durable event carries a monotonic sequence number,
 * which is what tells a row that has already been drawn from one that has not.
 */

/** Consumes durable events in sequence order, each exactly once. */
export class FoldCursor {
  private through: number | undefined

  /**
   * Start a fresh transcript.
   *
   * Sequence numbers are per session, so a fold that begins a new transcript
   * must not measure its events against the previous session's numbering.
   */
  reset(): void {
    this.through = undefined
  }

  /** Whether an event still has to be folded, and record it when it does. */
  accept(event: ForkEvent): boolean {
    if (typeof event.seq === 'number') {
      if (this.through !== undefined && event.seq <= this.through) return false
      this.through = event.seq
    }
    return true
  }
}
