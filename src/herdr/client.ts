/**
 * The Herdr socket.
 *
 * Every method resolves rather than throws: a multiplexer that is absent, busy,
 * or restarting is not a failure this surface may surface to its reader, whose
 * conversation is the thing on screen. The same reasoning keeps the transport
 * off stdout and stderr — the alternate screen owns both.
 */

import { createConnection } from 'node:net'
import {
  DEFAULT_ATTEMPTS,
  DEFAULT_TIMEOUT_MS,
  HERDR_AGENT,
  HERDR_ENV_FLAG,
  HERDR_ENV_VAR,
  HERDR_PANE_ID_VAR,
  HERDR_SOCKET_PATH_VAR,
  HERDR_SOURCE,
  HERDR_STATES,
  MAX_METADATA_VALUE_CHARS,
  MAX_RESPONSE_BYTES,
  RESPONSE_DELIMITER,
  type HerdrState,
  type SessionStartReason,
} from './constants.ts'

export type HerdrEnvironment = Readonly<Record<string, string | undefined>>

export interface HerdrClientOptions {
  readonly attempts?: number
  readonly timeoutMs?: number
}

export interface StateReport {
  readonly state: HerdrState
  readonly message: string | undefined
  readonly seq: number
  readonly sessionId: string | undefined
}

export interface SessionReport {
  readonly sessionId: string
  readonly seq: number
  readonly reason: SessionStartReason
}

/**
 * What a pane's agent row reads as, from the outside.
 *
 * `none` and `unknown` are the distinction the reclaim loop rests on: a pane
 * with no row is one this surface has to claim again, while a pane Herdr could
 * not be asked about is one it has to leave alone.
 */
export type PaneRow = 'ours' | 'other' | 'none' | 'unknown'

export interface HerdrClient {
  /** Whether Herdr started this process and asked to be told about it. */
  readonly enabled: boolean
  /**
   * Whether Herdr still shows this pane's row.
   *
   * Herdr accepts a stale report the same way it accepts a fresh one, so the
   * pane is the only proof a claim survived: this is the read that turns a
   * silent loss of the row into something the surface can answer.
   */
  readRow(): Promise<PaneRow>
  reportState(report: StateReport): Promise<boolean>
  reportSession(report: SessionReport): Promise<boolean>
  reportMetadata(tokens: Readonly<Record<string, string | undefined>>): Promise<boolean>
  /**
   * What Herdr writes for a blocked row, or the request to forget that label.
   *
   * A separate channel from the state report because Herdr keeps a wait's
   * message without rendering it: the display label is the one its sidebar
   * reads, so naming the decision the reader owes needs both.
   */
  reportStateLabel(label: string | undefined): Promise<boolean>
  /** Stop accepting reports and drop the ones still waiting. */
  stop(): void
  /** Wait until the transport has finished everything it took on. */
  settle(): Promise<void>
}

interface WireRequest {
  readonly id: string
  readonly method: string
  readonly params: Record<string, unknown>
}

interface QueuedReport {
  readonly request: WireRequest
  /**
   * Whether a newer report of the same kind makes this one pointless.
   *
   * A state describes the pane now, so a socket that was down while a turn ran
   * must be told the state it is in rather than the states it passed through;
   * a session and its tokens are facts about an event, and every one of them
   * happened.
   */
  readonly coalescing: boolean
  readonly settle: (delivered: boolean) => void
}

/**
 * Create the client for one pane.
 *
 * Requests are serialized instead of racing: state reports are sequenced
 * server-side, and a queue keeps a session's identity arriving before the state
 * that names it. The queue is bounded in practice because states change a
 * handful of times a turn and each attempt is spent against one deadline.
 */
export function createHerdrClient(env: HerdrEnvironment = process.env, options: HerdrClientOptions = {}): HerdrClient {
  const paneId = env[HERDR_PANE_ID_VAR]
  const socketPath = env[HERDR_SOCKET_PATH_VAR]
  // Herdr exports all three together; requiring each keeps a half-configured
  // environment from producing reports that name no pane.
  const enabled = env[HERDR_ENV_VAR] === HERDR_ENV_FLAG && paneId !== undefined && socketPath !== undefined
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS)
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  let requestNumber = 0
  let queued: QueuedReport[] = []
  let pumping = false
  let closed = false
  let waiters: Array<() => void> = []

  const wake = (): void => {
    const waiting = waiters
    waiters = []
    for (const resolve of waiting) resolve()
  }

  const deliver = async (request: WireRequest): Promise<boolean> =>
    socketPath === undefined
      ? true
      : sendWithRetry(socketPath, request, attempts, timeoutMs, () => closed)

  const pump = async (): Promise<void> => {
    if (pumping) return
    pumping = true
    try {
      while (!closed && queued.length > 0) {
        const next = queued.shift()
        if (next === undefined) break
        next.settle(await deliver(next.request))
      }
    } finally {
      pumping = false
      wake()
    }
  }

  const enqueue = (method: string, params: Record<string, unknown>, coalescing: boolean): Promise<boolean> =>
    new Promise<boolean>(resolve => {
      if (closed || !enabled || paneId === undefined || socketPath === undefined) {
        resolve(true)
        return
      }
      const request: WireRequest = {
        id: `${HERDR_SOURCE}:${String(process.pid)}:${String(++requestNumber)}`,
        method,
        params: { pane_id: paneId, source: HERDR_SOURCE, agent: HERDR_AGENT, ...params },
      }
      if (coalescing && queued.some(entry => entry.coalescing)) {
        const superseded = queued.filter(entry => entry.coalescing)
        queued = queued.filter(entry => !entry.coalescing)
        // Superseded, not lost: the report that replaced it says what this one
        // said and more, so nothing is left owed to Herdr.
        for (const entry of superseded) entry.settle(true)
      }
      queued.push({ request, coalescing, settle: resolve })
      void pump()
    })

  return {
    enabled,
    async readRow() {
      if (closed || !enabled || paneId === undefined || socketPath === undefined) return 'unknown'
      const answer = await requestWithRetry(socketPath, {
        id: `${HERDR_SOURCE}:${String(process.pid)}:${String(++requestNumber)}`,
        method: 'pane.get',
        params: { pane_id: paneId },
      }, attempts, timeoutMs, () => closed)
      if (!answer.ok) return 'unknown'
      const agent = paneAgent(answer.result)
      if (agent === undefined) return 'unknown'
      if (agent === null) return 'none'
      return agent === HERDR_AGENT ? 'ours' : 'other'
    },
    reportState(report) {
      return enqueue('pane.report_agent', {
        state: report.state,
        seq: report.seq,
        ...(report.message === undefined ? {} : { message: report.message }),
        ...(report.sessionId === undefined ? {} : { agent_session_id: report.sessionId }),
      }, true)
    },
    reportSession(report) {
      return enqueue('pane.report_agent_session', {
        agent_session_id: report.sessionId,
        seq: report.seq,
        session_start_source: report.reason,
      }, false)
    },
    reportMetadata(tokens) {
      return enqueue('pane.report_metadata', {
        applies_to_source: HERDR_SOURCE,
        tokens: acceptedTokens(tokens),
      }, false)
    },
    reportStateLabel(label) {
      // Not coalescing on purpose: a coalescing entry supersedes every coalescing
      // one already queued, so a label riding that channel would silently drop a
      // state report still waiting to be sent. The label is display-only and the
      // queue is serial, so arrival order is all the ordering it needs.
      return enqueue('pane.report_metadata', {
        applies_to_source: HERDR_SOURCE,
        ...(label === undefined
          ? { clear_state_labels: true }
          : { state_labels: { [HERDR_STATES.blocked]: label } }),
      }, false)
    },
    stop() {
      // Nothing still waiting is sent once the pane stops being an agent: Herdr
      // ignores the release of a pane nothing has claimed, so a report that
      // landed after the release would claim the row back for a process on its
      // way out. What is already on the wire is left to finish — the waiters
      // hear about it when it does, not before.
      closed = true
      const discarded = queued
      queued = []
      for (const entry of discarded) entry.settle(false)
    },
    async settle() {
      // The wait ends when the transport itself is done, not when a timer says
      // so: a report whose first attempt failed still has its retries to spend,
      // and a release that ran between them would be answered as a pane with
      // nothing to clear, leaving the row for that report to claim back. A
      // report's own budget is what bounds this.
      if (!pumping) return
      await new Promise<void>(resolve => {
        waiters.push(resolve)
      })
    },
  }
}

/**
 * The tokens Herdr will accept, with the ones it cannot hold cleared.
 *
 * An over-long value is not refused: Herdr cuts it at the limit, so a path that
 * was too long would come back shortened and read as another directory. A null
 * is the one value that tells Herdr to forget the token, which is the honest
 * answer for a fact that cannot be represented.
 */
function acceptedTokens(tokens: Readonly<Record<string, string | undefined>>): Record<string, string | null> {
  const accepted: Record<string, string | null> = {}
  for (const [key, value] of Object.entries(tokens)) {
    accepted[key] = value === undefined || value.length > MAX_METADATA_VALUE_CHARS ? null : value
  }
  return accepted
}

/** Herdr's socket is a named pipe on Windows. */
export function socketEndpoint(path: string): string {
  return process.platform === 'win32' ? `\\\\.\\pipe\\${path}` : path
}

/**
 * What the socket answered.
 *
 * A report only has to be accepted, while a read has to be read: both are the
 * same exchange, so the answer carries the value and the callers that file
 * reports look at nothing but `ok`.
 */
interface WireAnswer {
  readonly ok: boolean
  readonly result: unknown
}

const NO_ANSWER: WireAnswer = { ok: false, result: undefined }

/**
 * Spend one request's budget, not one per attempt.
 *
 * The deadline covers the whole request: a server that accepts a connection and
 * answers slowly, but always within the idle timeout, would otherwise hold the
 * queue open packet by packet for as long as it liked.
 */
async function sendWithRetry(
  path: string,
  request: WireRequest,
  attempts: number,
  timeoutMs: number,
  stopped: () => boolean,
): Promise<boolean> {
  return (await requestWithRetry(path, request, attempts, timeoutMs, stopped)).ok
}

async function requestWithRetry(
  path: string,
  request: WireRequest,
  attempts: number,
  timeoutMs: number,
  stopped: () => boolean,
): Promise<WireAnswer> {
  const deadline = Date.now() + timeoutMs
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // A stopped transport does not try again: the pane is no longer an agent,
    // and an attempt that landed after the release would claim the row back.
    if (stopped()) return NO_ANSWER
    const remaining = deadline - Date.now()
    if (remaining <= 0) return NO_ANSWER
    const answer = await requestAttempt(path, request, remaining)
    if (answer.ok) return answer
  }
  return NO_ANSWER
}

function requestAttempt(path: string, request: WireRequest, timeoutMs: number): Promise<WireAnswer> {
  return new Promise<WireAnswer>(resolve => {
    const socket = createConnection(socketEndpoint(path))
    const chunks: Buffer[] = []
    let received = 0
    let settled = false

    const finish = (answer: WireAnswer): void => {
      if (settled) return
      settled = true
      clearTimeout(expiry)
      socket.destroy()
      resolve(answer)
    }

    // Idle time is the fast signal; the hard deadline is what a peer that keeps
    // the socket busy cannot postpone.
    const expiry = setTimeout(() => finish(NO_ANSWER), timeoutMs)
    socket.setTimeout(timeoutMs, () => finish(NO_ANSWER))
    socket.once('error', () => finish(NO_ANSWER))
    socket.once('end', () => finish(NO_ANSWER))
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}${RESPONSE_DELIMITER}`))
    socket.on('data', (chunk: Buffer) => {
      received += chunk.byteLength
      if (received > MAX_RESPONSE_BYTES) {
        finish(NO_ANSWER)
        return
      }
      chunks.push(chunk)
      const response = Buffer.concat(chunks, received).toString('utf8')
      const end = response.indexOf(RESPONSE_DELIMITER)
      // A report is only delivered when Herdr says so: a write into a socket
      // that closed on the far side would otherwise look like success.
      if (end >= 0) finish(answerFor(response.slice(0, end), request.id))
    })
  })
}

function answerFor(response: string, requestId: string): WireAnswer {
  try {
    const parsed = JSON.parse(response) as unknown
    if (!isRecord(parsed) || parsed.id !== requestId || 'error' in parsed) return NO_ANSWER
    return 'result' in parsed ? { ok: true, result: parsed.result } : NO_ANSWER
  } catch {
    return NO_ANSWER
  }
}

/**
 * The agent label a `pane.get` answer carries.
 *
 * Herdr drops the field entirely once the row is gone rather than sending a
 * null, so a pane object that names no agent is the answer the reclaim loop
 * acts on. An answer without a pane object at all is one this code cannot read,
 * and a read that cannot be read must never be the reason for a write.
 */
function paneAgent(result: unknown): string | null | undefined {
  if (!isRecord(result)) return undefined
  const pane = result.pane
  if (!isRecord(pane)) return undefined
  const agent = pane.agent
  return typeof agent === 'string' ? agent : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
