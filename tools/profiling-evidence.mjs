/** Actual process exit and private artifacts prove profiling without a test-only runtime seam. */
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const MISSING_DIRECTORY_CODE = 'ENOENT'
const ENCODING = 'utf8'
const REPORT_PREFIX = 'dsh-tui profiling: '
const REPORT_FAILURE = REPORT_PREFIX + 'report could not be written'
const FILE_SEPARATOR = '_'
const DEFAULT_REPORT_COUNT = 1
const LATEST_REPORT_INDEX = -1
const SINGLE_LINK_COUNT = 1
const EMPTY_REPORT_COUNT = 0
const MIN_ELAPSED_MS = 0
const PRIVATE_DIRECTORY_MODE = 0o700
const COUNT_ERROR = 'dogfood: expected profiling reports, found '
const TIMING_ERROR = 'dogfood: invalid profiling timing '
const MILESTONE_ERROR = 'dogfood: invalid profiling milestone '
const COMPLETE_PHASE_ERROR = 'dogfood: missing completed profiling phase '
const FAILED_PHASE_ERROR = 'dogfood: missing failed profiling phase '
const FAILED_LAUNCH_ERROR = 'dogfood: failed launch claimed milestone '
const WRITE_FAILURE_STATUS = 'report-write-failed'
const COMPLETE_CATEGORY_ERROR = 'dogfood: missing completed '
const CATEGORY_PHASE_SEPARATOR = ' phase '
const DIRECTORY_PRIVACY_ERROR = 'dogfood: profiling directory is not private'
const STARTUP_READINESS_ERROR = 'dogfood: profiling startup ignored independent readiness milestones'
const FLAGLESS_REPORT_ERROR = 'dogfood: flagless invocation wrote a profiling report'
const WRITE_FAILURE_ERROR = 'dogfood: profiling persistence failure changed exit behavior or lacked diagnostics'
const INVALID_FILENAME_ERROR = 'dogfood: invalid profiling filename'
const UNSAFE_FILE_ERROR = 'dogfood: profiling report is not a private unshared regular file'
const INVOCATION_ID_ERROR = 'dogfood: session replacement changed profiling invocation identity'
const PRIVATE_CONTENT_ERROR = 'dogfood: profiling report retained private draft content'
const SCHEMA_ERROR = 'dogfood: invalid profiling schema, unit, or exit code'
const FILENAME_ID_ERROR = 'dogfood: profiling filename lost invocation identity'
const MISSING_LIFETIME_ERROR = 'dogfood: missing process lifetime'
const PHASE_CLOCK_ERROR = 'dogfood: invalid profiling phase status or clock'
const INCOMPLETE_PHASE_ERROR = 'dogfood: incomplete phase claimed completion'
const PHASE_DURATION_ERROR = 'dogfood: inconsistent profiling phase duration'
const EXIT_PATH_ERROR = 'dogfood: wrong profiling exit path'
const MISSING_READINESS_ERROR = 'dogfood: profiled surface never became ready'
const MISSING_PATH_ERROR = 'dogfood: profiling report path was not printed'
const RESTORATION_ORDER_ERROR = 'dogfood: profiling path printed before terminal restoration'
const REPORT_PARTS = ['profiles', 'tui', 'profiling']
const REPORT_SUFFIX = '.json'
const TIMESTAMP_SUFFIX_LENGTH = 29
const ENTER_ALTERNATE_SCREEN = '\x1b[?1049h'
const EXIT_ALTERNATE_SCREEN = '\x1b[?1049l'
const PRIVATE_FILE_MODE = 0o600
const MODE_MASK = 0o777
const SCHEMA_VERSION = 1
const TIMING_UNIT = 'ms'
const COMPLETE = 'complete'
const FAILED = 'failed'
const INCOMPLETE = 'incomplete'
const PHASE_STATUSES = new Set([COMPLETE, FAILED, INCOMPLETE])
const REQUIRED_TIMES = ['processLifetimeMs', 'firstFrameMs', 'inputReadyMs', 'startupMs', 'shutdownMs']
const CLOCK_TOLERANCE_MS = 0.001
const REPORT_FILENAME = /^[^/\\]+_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.json$/u

/** Reports must describe observed events, not merely exist beside a successful quit. */
export function verifyProfilingEvidence(home, expected, raw, exitCode, evidence, initialSessionId) {
  const directory = join(home, ...REPORT_PARTS)
  let names
  try { names = readdirSync(directory).filter(name => name.endsWith(REPORT_SUFFIX)) } catch (error) {
    if (error.code !== MISSING_DIRECTORY_CODE) throw error
    names = []
  }
  if (expected === false) {
    if (names.length !== EMPTY_REPORT_COUNT) throw new Error(FLAGLESS_REPORT_ERROR)
    return
  }
  if (expected.failure) {
    if (names.length !== EMPTY_REPORT_COUNT || !raw.includes(REPORT_FAILURE)) {
      throw new Error(WRITE_FAILURE_ERROR)
    }
    evidence({ status: WRITE_FAILURE_STATUS, exitCode })
    return
  }
  names.sort((left, right) => left.slice(-TIMESTAMP_SUFFIX_LENGTH).localeCompare(right.slice(-TIMESTAMP_SUFFIX_LENGTH)))
  if (names.length !== (expected.count ?? DEFAULT_REPORT_COUNT)) throw new Error(COUNT_ERROR + names.length)
  const name = names.at(LATEST_REPORT_INDEX)
  if (!REPORT_FILENAME.test(name)) throw new Error(INVALID_FILENAME_ERROR)
  const file = join(directory, name)
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== SINGLE_LINK_COUNT || (stat.mode & MODE_MASK) !== PRIVATE_FILE_MODE) {
    throw new Error(UNSAFE_FILE_ERROR)
  }
  const directoryStat = lstatSync(directory)
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & MODE_MASK) !== PRIVATE_DIRECTORY_MODE) {
    throw new Error(DIRECTORY_PRIVACY_ERROR)
  }
  const contents = readFileSync(file, ENCODING)
  const report = JSON.parse(contents)
  if (expected.stableLaunch && report.sessionId !== initialSessionId) throw new Error(INVOCATION_ID_ERROR)
  for (const excluded of expected.excluded ?? []) {
    if (contents.includes(excluded)) throw new Error(PRIVATE_CONTENT_ERROR)
  }
  if (report.schemaVersion !== SCHEMA_VERSION || report.timing.unit !== TIMING_UNIT || report.exit.code !== exitCode) {
    throw new Error(SCHEMA_ERROR)
  }
  if (!name.startsWith(encodeURIComponent(report.sessionId) + FILE_SEPARATOR)) throw new Error(FILENAME_ID_ERROR)
  for (const key of REQUIRED_TIMES) {
    const value = report.timing[key]
    if (value !== null && (!Number.isFinite(value) || value < MIN_ELAPSED_MS)) throw new Error(TIMING_ERROR + key)
  }
  if (!Number.isFinite(report.timing.processLifetimeMs)) throw new Error(MISSING_LIFETIME_ERROR)
  for (const [key, value] of Object.entries(report.milestones)) {
    if (value !== null && (!Number.isFinite(value) || value < MIN_ELAPSED_MS || value > report.timing.processLifetimeMs)) {
      throw new Error(MILESTONE_ERROR + key)
    }
  }
  // Startup waits for whichever independently observed readiness event finishes last, not merely an early input callback.
  const readyTimes = [report.milestones.firstFrame, report.milestones.inputReady, report.milestones.launcherReady]
  const expectedStartup = readyTimes.some(value => value === null) ? null : Math.max(...readyTimes)
  if (report.timing.startupMs !== expectedStartup) throw new Error(STARTUP_READINESS_ERROR)
  for (const phase of report.phases) {
    if (!PHASE_STATUSES.has(phase.status) || !Number.isFinite(phase.startMs) || phase.startMs < MIN_ELAPSED_MS) {
      throw new Error(PHASE_CLOCK_ERROR)
    }
    if (phase.status === INCOMPLETE) {
      if (phase.endMs !== null || phase.durationMs !== null) throw new Error(INCOMPLETE_PHASE_ERROR)
    } else if (!Number.isFinite(phase.endMs) || phase.endMs < phase.startMs || phase.endMs > report.timing.processLifetimeMs ||
      Math.abs(phase.durationMs - (phase.endMs - phase.startMs)) > CLOCK_TOLERANCE_MS) {
      throw new Error(PHASE_DURATION_ERROR)
    }
  }
  for (const phase of expected.phases ?? []) {
    if (!report.phases.some(row => row.name === phase && row.status === COMPLETE)) throw new Error(COMPLETE_PHASE_ERROR + phase)
  }
  for (const expectedPhase of expected.categories ?? []) {
    if (!report.phases.some(row => row.name === expectedPhase.name && row.category === expectedPhase.category && row.status === COMPLETE)) {
      throw new Error(COMPLETE_CATEGORY_ERROR + expectedPhase.category + CATEGORY_PHASE_SEPARATOR + expectedPhase.name)
    }
  }
  if (expected.reason && report.exit.reason !== expected.reason) throw new Error(EXIT_PATH_ERROR)
  for (const phase of expected.failedPhases ?? []) {
    if (!report.phases.some(row => row.name === phase && row.status === FAILED)) throw new Error(FAILED_PHASE_ERROR + phase)
  }
  for (const milestone of expected.missing ?? []) {
    if (report.milestones[milestone] !== null) throw new Error(FAILED_LAUNCH_ERROR + milestone)
  }
  if (expected.ready && (report.timing.startupMs === null || report.timing.firstFrameMs === null)) {
    throw new Error(MISSING_READINESS_ERROR)
  }
  if (!raw.includes(REPORT_PREFIX + file)) throw new Error(MISSING_PATH_ERROR)
  if (raw.includes(ENTER_ALTERNATE_SCREEN) && (!raw.includes(EXIT_ALTERNATE_SCREEN) || raw.indexOf(REPORT_PREFIX) <= raw.lastIndexOf(EXIT_ALTERNATE_SCREEN))) {
    throw new Error(RESTORATION_ORDER_ERROR)
  }
  // Keep a copy outside scratch-home cleanup so a reviewer can inspect the exact receipt.
  evidence(report)
}
