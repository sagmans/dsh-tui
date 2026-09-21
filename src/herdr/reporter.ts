/**
 * Telling a containing Herdr what this pane is doing.
 *
 * The reporter is inert unless Herdr started this process and exported its
 * socket, so the surface behaves identically in a bare terminal and never
 * depends on the multiplexer being there. Nothing here may reach the reader:
 * a report is best-effort, its failures are dropped, and the alternate screen
 * owns stdout.
 */

import { spawnSync } from 'node:child_process'
import { createHerdrClient, type HerdrClient, type HerdrEnvironment } from './client.ts'
import {
  EXIT_RELEASE_TIMEOUT_MS,
  HERDR_AGENT,
  HERDR_BIN_PATH_VAR,
  HERDR_ENV_FLAG,
  HERDR_ENV_VAR,
  HERDR_PANE_ID_VAR,
  HERDR_SOCKET_PATH_VAR,
  HERDR_SOURCE,
  METADATA_TOKENS,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  type SessionStartReason,
} from './constants.ts'
import { boundedMessage, createReportSequence, isReportChange, lifecycleReport, type LifecycleReport } from './state.ts'

export interface HerdrSessionInput {
  readonly id: string
  readonly cwd: string
  readonly reason: SessionStartReason
}

export interface HerdrReporterOptions {
  readonly client?: HerdrClient
  readonly env?: HerdrEnvironment
  readonly now?: () => number
  readonly releaseSync?: () => void
  /** The first retry wait; a test cannot wait a socket out. */
  readonly retryBaseMs?: number | undefined
}

export interface HerdrReporter {
  readonly enabled: boolean
  /** A turn started. */
  working(): void
  /** A turn ended. */
  idle(): void
  /** A decision is waiting on the reader; waits stack, so they are counted. */
  block(message: string): void
  /** One waiting decision was settled, answered, or abandoned. */
  unblock(): void
  /** The pane opened, resumed, forked, or switched to a session. */
  session(input: HerdrSessionInput): void
  /** Send the current facts, or resend them with `force`. */
  publish(force?: boolean): void
  /** Hand the pane's agent row back before the process leaves. */
  releaseSync(): void
  /** Hand the row back with the reports already on the wire settled. */
  release(): Promise<void>
  /** Release on process exit; returns the unregister function. */
  registerExitRelease(): () => void
}

export function createHerdrReporter(options: HerdrReporterOptions = {}): HerdrReporter {
  const env = options.env ?? process.env
  const client = options.client ?? createHerdrClient(env)
  const nextSeq = createReportSequence(options.now ?? Date.now)
  // A fresh sequence rides along: Herdr keeps the newest number per source and
  // drops a release that cannot beat the reports this pane already sent.
  const release = options.releaseSync ?? ((): void => releaseAgentSync(env, nextSeq()))
  const retryBaseMs = Math.max(1, options.retryBaseMs ?? RETRY_BASE_MS)
  let blockedCount = 0
  let blockedMessage: string | undefined
  let turnOpen = false
  let sessionId: string | undefined
  let wantedState: LifecycleReport | undefined
  let wantedSession: { readonly sessionId: string; readonly reason: SessionStartReason } | undefined
  let wantedMetadata: Readonly<Record<string, string | undefined>> | undefined
  let stateSent = false
  let sessionSent = false
  let metadataSent = false
  let released = false
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let retryAttempt = 0

  const owed = (): boolean =>
    (wantedState !== undefined && !stateSent) ||
    (wantedSession !== undefined && !sessionSent) ||
    (wantedMetadata !== undefined && !metadataSent)

  const cancelRetry = (): void => {
    if (retryTimer !== undefined) clearTimeout(retryTimer)
    retryTimer = undefined
    retryAttempt = 0
  }

  /**
   * Try an unacknowledged report again, later.
   *
   * A report that failed leaves the pane reading as something it is not, and
   * the surface may have nothing else to say: a turn that ended while the
   * socket was down produces no further event, so the retry cannot wait for
   * one. The wait backs off so a socket that stays down is not hammered, and it
   * never holds the process open.
   */
  const scheduleRetry = (): void => {
    if (released || retryTimer !== undefined) return
    retryAttempt += 1
    const wait = Math.min(retryBaseMs * 2 ** (retryAttempt - 1), RETRY_MAX_MS)
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      flush()
    }, wait)
    retryTimer.unref()
  }

  /**
   * Send what Herdr has not acknowledged.
   *
   * A report that failed is still owed: a socket that was down while a turn ran
   * would otherwise leave the pane reading as working forever, and a session
   * whose identity never arrived is one a reader cannot return to. Each flag is
   * set before the send and cleared only by a failure, so the next publish
   * retries exactly what is missing and a delivered report is never repeated.
   */
  const flush = (): void => {
    if (released) return
    const afterDelivery = (delivered: boolean): void => {
      if (!delivered) {
        scheduleRetry()
        return
      }
      if (!owed()) cancelRetry()
    }
    if (wantedSession !== undefined && !sessionSent) {
      const report = wantedSession
      sessionSent = true
      void client.reportSession({ sessionId: report.sessionId, seq: nextSeq(), reason: report.reason })
        .then(delivered => {
          if (!delivered) sessionSent = false
          afterDelivery(delivered)
        })
    }
    if (wantedMetadata !== undefined && !metadataSent) {
      const tokens = wantedMetadata
      metadataSent = true
      void client.reportMetadata(tokens).then(delivered => {
        if (!delivered) metadataSent = false
        afterDelivery(delivered)
      })
    }
    if (wantedState !== undefined && !stateSent) {
      const next = wantedState
      stateSent = true
      void client.reportState({ state: next.state, message: next.message, seq: nextSeq(), sessionId })
        .then(delivered => {
          if (!delivered) stateSent = false
          afterDelivery(delivered)
        })
    }
  }

  const reporter: HerdrReporter = {
    enabled: client.enabled,
    working() {
      turnOpen = true
      reporter.publish()
    },
    idle() {
      turnOpen = false
      reporter.publish()
    },
    block(message) {
      blockedCount += 1
      blockedMessage = boundedMessage(message)
      reporter.publish()
    },
    unblock() {
      blockedCount = Math.max(0, blockedCount - 1)
      // The last wait settled, so the message it was named by is stale; a later
      // wait brings its own.
      if (blockedCount === 0) blockedMessage = undefined
      reporter.publish()
    },
    session(input) {
      sessionId = input.id
      wantedSession = { sessionId: input.id, reason: input.reason }
      sessionSent = false
      wantedMetadata = { [METADATA_TOKENS.session]: input.id, [METADATA_TOKENS.cwd]: input.cwd }
      metadataSent = false
      // Forced: a switch can land on the state Herdr already shows, and the
      // session identity is part of what the pane means.
      reporter.publish(true)
    },
    publish(force = false) {
      const next = lifecycleReport({ blockedCount, blockedMessage, turnOpen })
      if (force || isReportChange(wantedState, next)) {
        wantedState = next
        stateSent = false
      }
      flush()
    },
    releaseSync() {
      // One release is enough: both the exit path and the teardown path can ask,
      // and a second spawn would only delay the process leaving.
      if (released) return
      released = true
      cancelRetry()
      // Nothing may be reported after this: the pane is no longer an agent, and
      // a report that landed later would claim the row back for a process that
      // is on its way out.
      client.stop()
      release()
    },
    async release() {
      if (released) return
      // Reports already on the wire are waited for before the row goes back:
      // Herdr ignores the release of a pane nothing has claimed, so a report
      // that arrived after it would claim the row back with an older number.
      // The synchronous release stays as the path an exit cannot skip.
      client.stop()
      await client.settle()
      reporter.releaseSync()
    },
    registerExitRelease() {
      const listener = (): void => reporter.releaseSync()
      process.once('exit', listener)
      return () => {
        process.off('exit', listener)
      }
    },
  }

  return reporter
}

/**
 * Release the pane's agent row synchronously.
 *
 * The process is leaving, so an awaited report would be dropped with the event
 * loop and Herdr would keep showing a state nothing owns any more — a pane that
 * reads as blocked forever is worse than one that reads as ordinary. The CLI is
 * the only channel that still works at this point.
 *
 * `seq` is what makes the release land, so it is required rather than optional:
 * Herdr sequences reports per source and treats a release that cannot beat them
 * as stale, which would leave the row of a process that is already gone.
 */
export function releaseAgentSync(env: HerdrEnvironment, seq: number): void {
  const paneId = env[HERDR_PANE_ID_VAR]
  if (env[HERDR_ENV_VAR] !== HERDR_ENV_FLAG || paneId === undefined || env[HERDR_SOCKET_PATH_VAR] === undefined) return
  const argv = ['pane', 'release-agent', paneId, '--source', HERDR_SOURCE, '--agent', HERDR_AGENT, '--seq', String(seq)]
  spawnSync(env[HERDR_BIN_PATH_VAR] ?? 'herdr', argv, {
    env: { ...process.env, ...env },
    stdio: 'ignore',
    timeout: EXIT_RELEASE_TIMEOUT_MS,
  })
}
