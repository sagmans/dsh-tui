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
  release(): Promise<boolean>
}

/**
 * Create the client for one pane.
 *
 * Requests are serialized on a single chain instead of racing: state reports
 * are sequenced server-side, and a chain keeps them arriving in the order the
 * surface decided them. The chain is bounded in practice because states change
 * a handful of times a turn, and a stuck socket costs one attempt budget.
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
  let tail: Promise<boolean> = Promise.resolve(true)

  const enqueue = (method: string, params: Record<string, unknown>): Promise<boolean> => {
    if (!enabled || paneId === undefined || socketPath === undefined) return Promise.resolve(true)
    const request = {
      id: `${HERDR_SOURCE}:${process.pid}:${String(++requestNumber)}`,
      method,
      params: { pane_id: paneId, source: HERDR_SOURCE, agent: HERDR_AGENT, ...params },
    }
    const delivery = tail.then(() => sendWithRetry(socketPath, request, attempts, timeoutMs))
    // The chain survives a failure so one lost report cannot stall the rest.
    tail = delivery.catch(() => false)
    return delivery
  }

  return {
    enabled,
    reportState(report) {
      return enqueue('pane.report_agent', {
        state: report.state,
        seq: report.seq,
        ...(report.message === undefined ? {} : { message: report.message }),
        ...(report.sessionId === undefined ? {} : { agent_session_id: report.sessionId }),
      })
    },
    reportSession(report) {
      return enqueue('pane.report_agent_session', {
        agent_session_id: report.sessionId,
        seq: report.seq,
        session_start_source: report.reason,
      })
    },
    reportMetadata(tokens) {
      return enqueue('pane.report_metadata', {
        applies_to_source: HERDR_SOURCE,
        tokens: acceptedTokens(tokens),
      })
    },
    release() {
      return enqueue('pane.release_agent', {})
    },
  }
}

/**
 * The tokens Herdr will accept.
 *
 * An over-long value fails the entire report, so a value that cannot fit is
 * dropped rather than sent: losing one token is cheaper than losing the pane's
 * session identity with it. A cwd is also the one value a reader controls by
 * naming a directory, so it is the one worth bounding.
 */
export function acceptedTokens(tokens: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const accepted: Record<string, string> = {}
  for (const [key, value] of Object.entries(tokens)) {
    if (value === undefined || value.length > MAX_METADATA_VALUE_CHARS) continue
    accepted[key] = value
  }
  return accepted
}

/** Herdr's socket is a named pipe on Windows. */
export function socketEndpoint(path: string): string {
  return process.platform === 'win32' ? `\\\\.\\pipe\\${path}` : path
}

async function sendWithRetry(
  path: string,
  request: { readonly id: string; readonly method: string; readonly params: Record<string, unknown> },
  attempts: number,
  timeoutMs: number,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await sendAttempt(path, request, timeoutMs)) return true
  }
  return false
}

function sendAttempt(
  path: string,
  request: { readonly id: string; readonly method: string; readonly params: Record<string, unknown> },
  timeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const socket = createConnection(socketEndpoint(path))
    const chunks: Buffer[] = []
    let received = 0
    let settled = false

    const finish = (delivered: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(delivered)
    }

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
