/**
 * The state decision, without any transport.
 *
 * Keeping this apart from the socket is what makes the mapping testable: the
 * surface knows facts about itself, Herdr wants one of three words, and the
 * translation between them is the part worth pinning down.
 */

import {
  HERDR_STATES,
  MAX_BLOCKED_MESSAGE_CHARS,
  SEQ_TIME_SCALE,
  SESSION_START_REASONS,
  type HerdrState,
  type SessionStartReason,
} from './constants.ts'

/** How the surface opened the session it is now showing. */
export interface SessionStartFacts {
  readonly forked: boolean
  readonly resumed: boolean
}
/** What the surface knows about itself. */
export interface LifecycleFacts {
  /** How many decisions are waiting on the reader; they can stack. */
  readonly blockedCount: number
  readonly blockedMessage: string | undefined
  readonly turnOpen: boolean
}

export interface LifecycleReport {
  readonly state: HerdrState
  readonly message: string | undefined
}

/**
 * The state Herdr should show.
 *
 * A wait outranks a running turn because a turn that is waiting on a human is
 * not making progress, and the wait is the only thing a reader glancing at a
 * wall of panes can still act on.
 */
export function lifecycleReport(facts: LifecycleFacts): LifecycleReport {
  if (facts.blockedCount > 0) return { state: HERDR_STATES.blocked, message: facts.blockedMessage }
  if (facts.turnOpen) return { state: HERDR_STATES.working, message: undefined }
  return { state: HERDR_STATES.idle, message: undefined }
}

/**
 * The message that names a wait, bounded.
 *
 * A title long enough to be cut still tells the reader which decision is
 * pending, which is the only job the message has.
 */
export function boundedMessage(message: string): string {
  const trimmed = message.replace(/\s+/gu, ' ').trim()
  return trimmed.length <= MAX_BLOCKED_MESSAGE_CHARS ? trimmed : `${trimmed.slice(0, MAX_BLOCKED_MESSAGE_CHARS - 1)}…`
}

/**
 * The reason Herdr is told a session opened.
 *
 * A fork and a resume are different acts to a reader scanning panes later: one
 * inherited a conversation, the other returned to it.
 */
export function sessionStartReason(input: SessionStartFacts): SessionStartReason {
  if (input.forked) return SESSION_START_REASONS.fork
  return input.resumed ? SESSION_START_REASONS.resume : SESSION_START_REASONS.startup
}

/** Whether a report would say something Herdr is not already showing. */
export function isReportChange(last: LifecycleReport | undefined, next: LifecycleReport): boolean {
  return last === undefined || last.state !== next.state || last.message !== next.message
}

/**
 * Monotonic report sequence numbers.
 *
 * The clock is the base rather than zero because a restarted surface must not
 * replay numbers this pane already used: Herdr would read them as stale and
 * keep showing the state from before the restart.
 */
export function createReportSequence(now: () => number): () => number {
  let sequence = now() * SEQ_TIME_SCALE
  return () => {
    sequence += 1
    return sequence
  }
}
