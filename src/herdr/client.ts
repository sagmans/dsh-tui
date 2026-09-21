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

export interface HerdrClient {
  /** Whether Herdr started this process and asked to be told about it. */
  readonly enabled: boolean
  reportState(report: StateReport): Promise<boolean>
  reportSession(report: SessionReport): Promise<boolean>
  reportMetadata(tokens: Readonly<Record<string, string | undefined>>): Promise<boolean>
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
export function acceptedTokens(tokens: Readonly<Record<string, string | undefined>>): Record<string, string | null> {
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
 * Spend one report's budget, not one per attempt.
 *
 * The deadline covers the whole report: a server that accepts a connection and
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
  const deadline = Date.now() + timeoutMs
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // A stopped transport does not try again: the pane is no longer an agent,
    // and an attempt that landed after the release would claim the row back.
    if (stopped()) return false
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    if (await sendAttempt(path, request, remaining)) return true
  }
  return false
}

function sendAttempt(path: string, request: WireRequest, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const socket = createConnection(socketEndpoint(path))
    const chunks: Buffer[] = []
    let received = 0
    let settled = false

    const finish = (delivered: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(expiry)
      socket.destroy()
      resolve(delivered)
    }

    // Idle time is the fast signal; the hard deadline is what a peer that keeps
    // the socket busy cannot postpone.
    const expiry = setTimeout(() => finish(false), timeoutMs)
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('error', () => finish(false))
    socket.once('end', () => finish(false))
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}${RESPONSE_DELIMITER}`))
    socket.on('data', (chunk: Buffer) => {
      received += chunk.byteLength
      if (received > MAX_RESPONSE_BYTES) {
        finish(false)
        return
      }
      chunks.push(chunk)
      const response = Buffer.concat(chunks, received).toString('utf8')
      const end = response.indexOf(RESPONSE_DELIMITER)
      // A report is only delivered when Herdr says so: a write into a socket
      // that closed on the far side would otherwise look like success.
      if (end >= 0) finish(isSuccess(response.slice(0, end), request.id))
    })
  })
}

function isSuccess(response: string, requestId: string): boolean {
  try {
    const parsed = JSON.parse(response) as unknown
    return isRecord(parsed) && parsed.id === requestId && 'result' in parsed && !('error' in parsed)
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
