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
  let blockedCount = 0
  let blockedMessage: string | undefined
  let turnOpen = false
  let sessionId: string | undefined
  let last: LifecycleReport | undefined
  let released = false

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
      void client.reportSession({ sessionId: input.id, seq: nextSeq(), reason: input.reason })
      void client.reportMetadata({ [METADATA_TOKENS.session]: input.id, [METADATA_TOKENS.cwd]: input.cwd })
      // Forced: a switch can land on the state Herdr already shows, and the
      // session identity is part of what the pane means.
      reporter.publish(true)
    },
    publish(force = false) {
      const next = lifecycleReport({ blockedCount, blockedMessage, turnOpen })
      if (!force && !isReportChange(last, next)) return
      last = next
      void client.reportState({ state: next.state, message: next.message, seq: nextSeq(), sessionId })
    },
    releaseSync() {
      // One release is enough: both the exit path and the teardown path can ask,
      // and a second spawn would only delay the process leaving.
      if (released) return
      released = true
      release()
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
