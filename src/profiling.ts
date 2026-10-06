/** Invocation ownership keeps terminal handoffs and session switches from finalizing somebody else's report. */
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, realpathSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { escapeTerminalText } from './terminal-text.ts'

const SCHEMA_VERSION = 1
const NODE_PROCESS_ORIGIN_MS = 0
const REPORT_PARTS = ['profiles', 'tui', 'profiling'] as const
const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const FILE_FLAG = 'wx'
const ENCODING = 'utf8'
const JSON_INDENT = 2
const STDERR_FD = 2
const MAX_PHASES = 512
const MAX_FILENAME_ID = 160
const DIGEST_LENGTH = 16
const DIGEST_ALGORITHM = 'sha256'
const DIGEST_ENCODING = 'hex'
const TIMESTAMP_UNSAFE = /:/gu
const TIMESTAMP_SEPARATOR = '-'
const FILE_SEPARATOR = '_'
const FILE_SUFFIX = '.json'
const EXIT_EVENT = 'exit'
const FILE_EXISTS_CODE = 'EEXIST'
const FATAL_EVENT = 'uncaughtExceptionMonitor'
const COMPLETE = 'complete'
const FAILED = 'failed'
const INCOMPLETE = 'incomplete'
const TIME_UNIT = 'ms'
const CLOCK_ORIGIN = 'node-process'
const PERSISTENCE_EXCLUSION = 'Final JSON serialization and write occur after processLifetimeMs is sampled.'
const REPORT_PREFIX = 'dsh-tui profiling: '
const REPORT_FAILURE = 'dsh-tui profiling: report could not be written'
const UNSAFE_DIRECTORY = 'profiling directory must not be a symlink or non-directory'
const UNSAFE_DIRECTORY_CODE = 'ERR_UNSAFE_PROFILING_DIRECTORY'

/** Stable labels let reports compare releases without retaining any session content. */
export const PROFILE_PHASE = {
  prePlugin: 'process-to-startup-plugin', pluginWait: 'startup-plugin-wait',
  cli: 'cli-parse', publication: 'startup-publication', surface: 'surface-construction',
  launch: 'launch-validation', boot: 'session-boot', picker: 'history-picker-wait', historyList: 'history-list',
  preset: 'preset-resolution', agent: 'agent-start', setup: 'agent-setup', replay: 'history-replay',
  terminalStart: 'terminal-start', inputStart: 'input-activation', firstFrame: 'first-frame',
  terminalStop: 'terminal-stop', terminalCleanup: 'native-terminal-cleanup',
  exitPreparation: 'exit-preparation', deferredExit: 'deferred-exit-wait',
  inputStop: 'input-restoration', transcript: 'transcript-and-screen-restore',
  cursorRestore: 'cursor-mode-restoration', warnings: 'warning-replay', hostWrites: 'host-write-release',
  herdr: 'pane-release', disposal: 'surface-disposal', agentDisposal: 'agent-disposal',
} as const
export type ProfilePhase = typeof PROFILE_PHASE[keyof typeof PROFILE_PHASE]

/** Milestones remain independent because host readiness and the first frame can race session boot. */
export const PROFILE_MILESTONE = {
  profilerStarted: 'profilerStarted', launcherReady: 'launcherReady', surfaceMounted: 'surfaceMounted',
  terminalActive: 'terminalActive', firstFrame: 'firstFrame', pickerReady: 'pickerReady',
  agentReady: 'agentReady', inputReady: 'inputReady', exitRequested: 'exitRequested',
  terminalRestored: 'terminalRestored', launcherExit: 'launcherExit', surfaceDisposed: 'surfaceDisposed',
  processExit: 'processExit',
} as const
type Milestone = typeof PROFILE_MILESTONE[keyof typeof PROFILE_MILESTONE]
/** Invocation services and report categories must not drift across independently owned lifecycle hooks. */
export const TUI_PROFILING_SERVICE = 'tuiProfiling'
export const PROFILE_CATEGORY = { startup: 'startup', shutdown: 'shutdown', handoff: 'handoff', session: 'session', userWait: 'user-wait' } as const
export const PROFILE_EXIT_REASON = { quit: 'quit', interrupted: 'interrupted', startupFailure: 'startup-failure', hostUnload: 'host-unload', fatal: 'fatal-error', processExit: 'process-exit' } as const
export type ProfileCategory = typeof PROFILE_CATEGORY[keyof typeof PROFILE_CATEGORY]
type ExitReason = typeof PROFILE_EXIT_REASON[keyof typeof PROFILE_EXIT_REASON]

interface Phase {
  readonly name: ProfilePhase
  readonly category: ProfileCategory
  readonly startMs: number
  endMs: number | null
  durationMs: number | null
  status: typeof COMPLETE | typeof FAILED | typeof INCOMPLETE
}

/** Optional hooks cost no timers and never acquire the launcher's exit authority. */
export interface LifecycleProfiler {
  begin(name: ProfilePhase, category?: ProfileCategory, startMs?: number): (failed?: boolean) => void
  mark(name: Milestone): void
  has(name: Milestone): boolean
  shutdown(reason: ExitReason): void
  /** Picker launches have a provisional identity until their first real session opens. */
  sessionOpened(sessionId: string): void
  readonly category: ProfileCategory
  /** Native crash restoration registers later, so finalization must follow those exit listeners. */
  afterExitRestoration(): void
}

/** Async boundaries retain failures without replacing the original rejection or awaiting extra work. */
export async function profileAsync<T>(profiling: LifecycleProfiler | undefined, name: ProfilePhase, work: () => Promise<T>, category?: ProfileCategory): Promise<T> {
  const finish = profiling?.begin(name, category)
  try {
    const value = await work()
    finish?.()
    return value
  } catch (error) {
    finish?.(true)
    throw error
  }
}

/** Synchronous terminal mutations must remain synchronous even when timing is enabled. */
export function profileSync<T>(profiling: LifecycleProfiler | undefined, name: ProfilePhase, work: () => T, category?: ProfileCategory): T {
  const finish = profiling?.begin(name, category)
  try {
    const value = work()
    finish?.()
    return value
  } catch (error) {
    finish?.(true)
    throw error
  }
}

/** Directory traversal is rejected before mkdir can follow an existing link into another tree. */
function reportDirectory(home: string): string {
  let directory = realpathSync(home)
  for (const part of REPORT_PARTS) {
    directory = join(directory, part)
    try {
      mkdirSync(directory, { mode: DIRECTORY_MODE })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== FILE_EXISTS_CODE) throw error
    }
    const stat = lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Object.assign(new Error(UNSAFE_DIRECTORY), { code: UNSAFE_DIRECTORY_CODE })
  }
  return directory
}

/** Long resumed identities still fit a filesystem component without losing collision resistance. */
function filenameIdentity(sessionId: string): string {
  const encoded = encodeURIComponent(sessionId)
  if (encoded.length <= MAX_FILENAME_ID) return encoded
  const digest = createHash(DIGEST_ALGORITHM).update(sessionId).digest(DIGEST_ENCODING).slice(0, DIGEST_LENGTH)
  return encoded.slice(0, MAX_FILENAME_ID) + FILE_SEPARATOR + digest
}

/** Exit diagnostics must not create an asynchronous write that a forced exit silently drops. */
function diagnostic(text: string): void {
  try { writeSync(STDERR_FD, escapeTerminalText(text) + '\n') } catch {
    // Broken stderr is not permission to replace the app's requested exit code.
  }
}

/** One recorder survives plugin unload so the host's remaining shutdown time stays observable. */
export function createLifecycleProfiler(options: {
  readonly home: string
  readonly sessionId: string
  readonly cliStartedAtMs: number
  readonly moduleLoadedAtMs: number
}): LifecycleProfiler {
  const startedAt = new Date().toISOString()
  const timestamp = startedAt.replace(TIMESTAMP_UNSAFE, TIMESTAMP_SEPARATOR)
  const phases: Phase[] = []
  const milestones = Object.fromEntries(Object.values(PROFILE_MILESTONE).map(name => [name, null])) as Record<Milestone, number | null>
  let droppedPhases = 0
  let firstSessionId: string | undefined
  let finalSessionId: string | undefined
  let reason: ExitReason = PROFILE_EXIT_REASON.processExit
  let finalized = false

  const profiler: LifecycleProfiler = {
    begin(name, category = profiler.category, startMs = performance.now()) {
      if (phases.length >= MAX_PHASES || finalized) {
        droppedPhases++
        return () => undefined
      }
      const phase: Phase = { name, category, startMs, endMs: null, durationMs: null, status: INCOMPLETE }
      phases.push(phase)
      return (failed = false) => {
        if (finalized || phase.endMs !== null) return
        phase.endMs = performance.now()
        phase.durationMs = phase.endMs - phase.startMs
        phase.status = failed ? FAILED : COMPLETE
      }
    },
    mark(name) {
      if (!finalized && milestones[name] === null) milestones[name] = performance.now()
    },
    has: name => milestones[name] !== null,
    shutdown(nextReason) {
      if (milestones.exitRequested === null) reason = nextReason
      profiler.mark(PROFILE_MILESTONE.exitRequested)
    },
    sessionOpened(sessionId) {
      firstSessionId ??= sessionId
      finalSessionId = sessionId
    },
    get category() {
      return milestones.exitRequested !== null ? PROFILE_CATEGORY.shutdown : milestones.inputReady === null ? PROFILE_CATEGORY.startup : PROFILE_CATEGORY.session
    },
    afterExitRestoration() {
      process.off(EXIT_EVENT, finalize)
      process.once(EXIT_EVENT, finalize)
    },
  }

  /** Finalization follows restoration and stays synchronous because Node cannot await an exit listener. */
  function finalize(code: number): void {
    if (finalized) return
    profiler.mark(PROFILE_MILESTONE.processExit)
    finalized = true
    const endMs = milestones.processExit!
    // A forced unload during an editor handoff must not print into the child that still owns the terminal.
    const terminalOutputSafe = milestones.terminalActive === null || milestones.terminalRestored !== null
    const report = {
      schemaVersion: SCHEMA_VERSION, sessionId: firstSessionId ?? options.sessionId,
      launchSessionId: options.sessionId, finalSessionId: finalSessionId ?? null, startedAt,
      processStartedAt: new Date(performance.timeOrigin).toISOString(),
      finishedAt: new Date(performance.timeOrigin + endMs).toISOString(),
      exit: { code, reason },
      runtime: { node: process.version, platform: process.platform },
      timing: {
        unit: TIME_UNIT, origin: CLOCK_ORIGIN, processLifetimeMs: endMs,
        firstFrameMs: milestones.firstFrame, inputReadyMs: milestones.inputReady,
        startupMs: milestones.firstFrame === null || milestones.inputReady === null || milestones.launcherReady === null
          ? null : Math.max(milestones.firstFrame, milestones.inputReady, milestones.launcherReady),
        shutdownMs: milestones.exitRequested === null ? null : endMs - milestones.exitRequested,
        persistenceExcluded: PERSISTENCE_EXCLUSION,
      },
      milestones, phases, droppedPhases,
    }
    try {
      const directory = reportDirectory(options.home)
      const file = join(directory, filenameIdentity(report.sessionId) + FILE_SEPARATOR + timestamp + FILE_SUFFIX)
      writeFileSync(file, JSON.stringify(report, null, JSON_INDENT) + '\n', { mode: FILE_MODE, flag: FILE_FLAG, encoding: ENCODING })
      if (terminalOutputSafe) diagnostic(REPORT_PREFIX + file)
    } catch (error) {
      // Error messages can include private paths or contents; a stable errno is sufficient for persistence failure.
      const code = (error as NodeJS.ErrnoException).code
      if (terminalOutputSafe) diagnostic(REPORT_FAILURE + (code === undefined ? '' : ` (${code})`))
    }
  }

  const fatal = (): void => profiler.shutdown(PROFILE_EXIT_REASON.fatal)
  process.once(FATAL_EVENT, fatal)
  process.once(EXIT_EVENT, finalize)
  profiler.mark(PROFILE_MILESTONE.profilerStarted)
  // Imported dependencies predate this plugin's module body, so only aggregate pre-plugin cost is claimed.
  phases.push({
    name: PROFILE_PHASE.prePlugin, category: PROFILE_CATEGORY.startup, startMs: NODE_PROCESS_ORIGIN_MS,
    endMs: options.moduleLoadedAtMs, durationMs: options.moduleLoadedAtMs - NODE_PROCESS_ORIGIN_MS, status: COMPLETE,
  })
  phases.push({
    name: PROFILE_PHASE.pluginWait, category: PROFILE_CATEGORY.startup, startMs: options.moduleLoadedAtMs,
    endMs: options.cliStartedAtMs, durationMs: options.cliStartedAtMs - options.moduleLoadedAtMs, status: COMPLETE,
  })
  profiler.begin(PROFILE_PHASE.cli, PROFILE_CATEGORY.startup, options.cliStartedAtMs)()
  return profiler
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Kept outside user configuration because profiling belongs to this invocation, not a saved preference. */
    tuiProfiling?: LifecycleProfiler
  }
}
