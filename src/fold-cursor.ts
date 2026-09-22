import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ForkEvent } from './agent/fork.ts'

/**
 * The fold's place in one session's durable event sequence.
 *
 * A resumed session is folded while its agent's loop is already live, so the
 * same event reaches the surface twice: once on the stream, once from the log
 * the fold is reading. Every durable event carries a monotonic sequence number,
 * which is what tells a row that has already been drawn from one that has not.
 *
 * The session is part of the question rather than the caller's memory: numbers
 * restart with every session, and a transcript that starts on a session other
 * than the one just read — what `/new` does — would otherwise measure the new
 * conversation against the old one's numbering and drop all of it.
 */

/** Consumes durable events in sequence order, each exactly once per session. */
export class FoldCursor {
  private session: SessionId | undefined
  private through: number | undefined

  /**
   * Start a fresh transcript.
   *
   * A fold re-reads a session from its first event — the same session the
   * cursor may already know — so the place it reached has to be given up.
   */
  reset(): void {
    this.session = undefined
    this.through = undefined
  }

  /** Whether an event still has to be folded, and record it when it does. */
  accept(session: SessionId, event: ForkEvent): boolean {
    if (session !== this.session) {
      this.session = session
      this.through = undefined
    }
    if (typeof event.seq === 'number') {
      if (this.through !== undefined && event.seq <= this.through) return false
      this.through = event.seq
    }
    return true
  }
}
