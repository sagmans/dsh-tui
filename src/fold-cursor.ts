import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ForkEvent } from './agent/fork.ts'

/**
 * The fold's place in one session's durable event sequence.
 *
 * A resumed session is folded while its agent's loop is already live, so the
 * same event reaches the surface twice: once on the stream, once from the log
 * the fold is reading. When an event carries a sequence number, the cursor uses
 * that number to suppress deliveries at or below the session's high-water mark.
 *
 * The session is part of the question rather than the caller's memory: numbers
 * restart with every session, and a transcript that starts on a session other
 * than the one just read — what `/new` does — would otherwise measure the new
 * conversation against the old one's numbering and drop all of it.
 */

/** A late stored log must not repaint a transcript the reader already left. */
export async function replayIfCurrent<Event>(
  read: () => Promise<readonly Event[]>,
  current: () => boolean,
  apply: (event: Event) => void,
): Promise<number> {
  const events = await read()
  if (!current()) return 0
  for (const event of events) apply(event)
  return events.length
}

/** An older asynchronous fold must lose ownership when the view resets. */
export class ViewGeneration {
  private generation = 0

  /** An old view cannot regain ownership if its read finishes out of order. */
  begin(): () => boolean {
    const generation = ++this.generation
    return () => generation === this.generation
  }
}

/** Suppress sequenced replay/live overlap per session; older arrivals are dropped, not reordered, and unsequenced deliveries always pass. */
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
    // Without a sequence, this cursor cannot identify replay/live overlap; dropping
    // the delivery could lose content. Unsequenced events can therefore repeat.
    if (typeof event.seq === 'number') {
      if (this.through !== undefined && event.seq <= this.through) return false
      this.through = event.seq
    }
    return true
  }
}
