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
  FALLBACK_HERDR_BIN,
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
import {
  boundedMessage,
  createReportSequence,
  isReportChange,
  lifecycleReport,
  stateLabelFor,
  type DriverStatus,
  type LifecycleReport,
} from './state.ts'

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
  /**
   * The agent's driver started or stopped running.
   *
   * Deliberately not a turn boundary: the harness chains turns through a
   * pending inbox inside one driver run, and reporting each turn's end would
   * read as done between two turns of an agent that is still working.
   */
  driver(status: DriverStatus): void
  /**
   * A decision is waiting on the reader, under the key of the slot holding it.
   *
   * Reporting a wait is what makes Herdr raise a needs-attention notification,
   * so only a decision the agent owes the reader is one: a menu the reader
   * opened themselves is navigation, not a wait. The title is offered to Herdr
   * twice, as the state's message and as its display label, because the message
   * is stored without being drawn and the label is what its sidebar renders.
   */
  block(key: string, message: string): void
  /** The wait held under that key was settled, answered, or abandoned. */
  unblock(key: string): void
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
  /**
   * The waits still owed, oldest first.
   *
   * A map keyed by the slot that opened the wait, so a slot taken over twice
   * holds one entry and gives it back once; the newest remaining wait is the one
   * that names the row, because the older ones are behind it in the reader's
   * queue rather than in front of it.
   */
  const waits = new Map<string, string>()
  let driverRunning = false
  let sessionId: string | undefined
  let wantedState: LifecycleReport | undefined
  let wantedSession: { readonly sessionId: string; readonly reason: SessionStartReason } | undefined
  let wantedMetadata: Readonly<Record<string, string | undefined>> | undefined
  /**
   * The label Herdr should be showing for a blocked row, if any.
   *
   * It starts settled rather than owed: a pane that has never held a wait has
   * nothing for Herdr to forget, and clearing a label it never received would be
   * a report spent on nothing.
   */
  let wantedLabel: string | undefined
  let stateSent = false
  let sessionSent = false
  let metadataSent = false
  let labelSent = true
  let released = false
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let retryAttempt = 0
  let releasing: Promise<void> | undefined

  const owed = (): boolean =>
    (wantedState !== undefined && !stateSent) ||
    (wantedSession !== undefined && !sessionSent) ||
    (wantedMetadata !== undefined && !metadataSent) ||
    !labelSent

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
    if (!labelSent) {
      // Ahead of the state so the row is named by the time it reads as blocked:
      // a reader glancing at the sidebar should not catch it without its title.
      const label = wantedLabel
      labelSent = true
      void client.reportStateLabel(label).then(delivered => {
        if (!delivered) labelSent = false
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
    driver(status) {
      driverRunning = status === 'running'
      reporter.publish()
    },
    block(key, message) {
      waits.set(key, boundedMessage(message))
      reporter.publish()
    },
    unblock(key) {
      // A key nothing holds is not a wait that ended: dropping it keeps a slot
      // that was taken over from clearing the row the new owner still needs.
      waits.delete(key)
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
      const next = lifecycleReport({ blockedCount: waits.size, blockedMessage: [...waits.values()].at(-1), driverRunning })
      if (force || isReportChange(wantedState, next)) {
        wantedState = next
        stateSent = false
      }
      const label = stateLabelFor(next)
      // Not forced with the state: a session switch changes what the pane is
      // called, never which decision it owes, so re-sending a label Herdr
      // already holds would be noise on the wire.
      if (label !== wantedLabel) {
        wantedLabel = label
        labelSent = false
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
    release() {
      if (released) return Promise.resolve()
      // Reports already on the wire are waited for before the row goes back:
      // Herdr ignores the release of a pane nothing has claimed, so a report
      // that arrived after it would claim the row back with an older number.
      // The synchronous release stays as the path an exit cannot skip. One
      // promise is shared so two callers cannot release against each other.
      releasing ??= (async () => {
        client.stop()
        await client.settle()
        reporter.releaseSync()
      })()
      return releasing
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
 *
 * The binary Herdr exported is tried first and the one on `PATH` second: the
 * exported path names the release that started this pane, and a multiplexer
 * upgraded while the pane ran can take that file away. A release that could not
 * spawn is silent by design, so the fallback is the only thing standing between
 * an exit and a row that reads as a live agent forever.
 */
export function releaseAgentSync(env: HerdrEnvironment, seq: number): void {
  const paneId = env[HERDR_PANE_ID_VAR]
  if (env[HERDR_ENV_VAR] !== HERDR_ENV_FLAG || paneId === undefined || env[HERDR_SOCKET_PATH_VAR] === undefined) return
  const argv = ['pane', 'release-agent', paneId, '--source', HERDR_SOURCE, '--agent', HERDR_AGENT, '--seq', String(seq)]
  const exported = env[HERDR_BIN_PATH_VAR]
  for (const bin of exported === undefined || exported === FALLBACK_HERDR_BIN ? [FALLBACK_HERDR_BIN] : [exported, FALLBACK_HERDR_BIN]) {
    // Only a spawn that could not start the binary at all is worth a second try:
    // a CLI that ran and refused the release would refuse it the same way again.
    if (spawnSync(bin, argv, {
      env: { ...process.env, ...env },
      stdio: 'ignore',
      timeout: EXIT_RELEASE_TIMEOUT_MS,
    }).error === undefined) return
  }
}
