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
/**
 * The harness driver lifecycle this surface reports on.
 *
 * Mirrors the harness AgentStatus by value rather than by import so the
 * Herdr wire stays a transport-only module; a running driver spans every
 * turn it chains through a pending inbox, which is exactly why the report
 * follows it instead of a turn boundary.
 */
export type DriverStatus = 'idle' | 'running'

/**
 * The driver status an agent/status payload carries, when it carries one
 * this surface knows.
 *
 * The event is listened to through a loose name so a harness rename cannot
 * break compilation, which leaves the payload untyped at the listener; the
 * vocabulary is decided here rather than at the call site so an unknown
 * future status is dropped instead of guessed at.
 */
export function asDriverStatus(value: unknown): DriverStatus | undefined {
  return value === 'idle' || value === 'running' ? value : undefined
}

/** What the surface knows about itself. */
export interface LifecycleFacts {
  /** How many decisions are waiting on the reader; they can stack. */
  readonly blockedCount: number
  readonly blockedMessage: string | undefined
  readonly driverRunning: boolean
}

export interface LifecycleReport {
  readonly state: HerdrState
  readonly message: string | undefined
}

/**
 * The state Herdr should show.
 *
 * A wait outranks a running driver because an agent that is waiting on a
 * human is not making progress, and the wait is the only thing a reader
 * glancing at a wall of panes can still act on.
 */
export function lifecycleReport(facts: LifecycleFacts): LifecycleReport {
  if (facts.blockedCount > 0) return { state: HERDR_STATES.blocked, message: facts.blockedMessage }
  if (facts.driverRunning) return { state: HERDR_STATES.working, message: undefined }
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
