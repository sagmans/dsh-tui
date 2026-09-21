/**
 * The Herdr side of this surface.
 *
 * Herdr is a terminal multiplexer for coding agents: when it starts a pane it
 * exports its own coordinates plus a socket, and anything running in that pane
 * may claim the pane's agent row. These are the names both ends of the claim
 * have to agree on, so they are fixed here rather than at the call sites.
 */

/** The value `HERDR_ENV` carries inside a pane Herdr itself started. */
export const HERDR_ENV_FLAG = '1'

export const HERDR_ENV_VAR = 'HERDR_ENV'
export const HERDR_PANE_ID_VAR = 'HERDR_PANE_ID'
export const HERDR_SOCKET_PATH_VAR = 'HERDR_SOCKET_PATH'
export const HERDR_BIN_PATH_VAR = 'HERDR_BIN_PATH'

/** The agent label Herdr shows, and the label its pickers and waits match on. */
export const HERDR_AGENT = 'dsh'

/**
 * This reporter's identity.
 *
 * Herdr scopes lifecycle state, report sequencing, and releases by
 * (source, agent), so a second tool reporting the same pane under its own
 * source cannot be mistaken for this one — and clearing this source's
 * authority leaves the other's alone.
 */
export const HERDR_SOURCE = 'custom:dsh-tui'

/** The three states a pane report may carry. */
export const HERDR_STATES = { idle: 'idle', working: 'working', blocked: 'blocked' } as const
export type HerdrState = (typeof HERDR_STATES)[keyof typeof HERDR_STATES]

/**
 * Why a session opened, in the words Herdr accepts.
 *
 * A reason outside this set is dropped server-side, so the surface reports the
 * nearest one it recognizes instead of inventing a label.
 */
export const SESSION_START_REASONS = { startup: 'startup', resume: 'resume', fork: 'fork', select: 'select' } as const
export type SessionStartReason = (typeof SESSION_START_REASONS)[keyof typeof SESSION_START_REASONS]

/**
 * Pane metadata keys.
 *
 * Herdr persists a session reference only for its own built-in integrations, so
 * the identity is published as tokens as well: those are readable back off the
 * pane by any script or plugin, which is what makes an exact resume possible
 * from outside this process.
 */
export const METADATA_TOKENS = { session: 'dsh_session', cwd: 'dsh_cwd' } as const

/** A report is best-effort, so its budget is short and it retries once. */
export const DEFAULT_ATTEMPTS = 2
export const DEFAULT_TIMEOUT_MS = 500

/** A release on the way out cannot outlive the process that owes it. */
export const EXIT_RELEASE_TIMEOUT_MS = 250

/** The first wait before a report Herdr did not acknowledge is sent again. */
export const RETRY_BASE_MS = 250

/** The longest that wait can grow to, so a down socket is still noticed. */
export const RETRY_MAX_MS = 8_000

/** Beyond this a response is a surprise, not an answer. */
export const MAX_RESPONSE_BYTES = 64 * 1024
export const RESPONSE_DELIMITER = '\n'

/**
 * The longest metadata value Herdr can hold whole.
 *
 * A longer value is shortened rather than refused, so a path past the limit
 * would come back reading as a different directory: a value this long is the
 * most the pane can say about itself, and anything longer has to be cleared.
 */
export const MAX_METADATA_VALUE_CHARS = 80

/**
 * How much of a wait's title is reported.
 *
 * The text names a tool the model chose, so it crosses a trust boundary into
 * another process's user interface: it is bounded here rather than handed over
 * whole.
 */
export const MAX_BLOCKED_MESSAGE_CHARS = 120

/**
 * Reports are sequenced in microseconds.
 *
 * Herdr keeps the newest sequence per source and ignores an older one, so a
 * delivery that arrives late cannot undo a state the surface already left.
 */
export const SEQ_TIME_SCALE = 1000
