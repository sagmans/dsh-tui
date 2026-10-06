/** Actual process exit and private artifacts prove profiling without a test-only runtime seam. */
import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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
const PHASE_COUNT_ERROR = 'dogfood: wrong profiling phase count '
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
const EVIDENCE_DIRECTORY = 'profiling'
const EVIDENCE_LATEST = 'profiling.json'
const FILE_START = 0
const EXISTING_PATH_CODE = 'EEXIST'
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK
const MODE_ERROR = 'dogfood: unsafe profiling evidence directory'
const REPORT_FILENAME = /^[^/\\]+_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.json$/u

/** Failure artifacts can contain rejected private content, so output must never follow links or widen access. */
function privateDirectory(directory) {
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & MODE_MASK) !== PRIVATE_DIRECTORY_MODE) throw new Error(MODE_ERROR)
}

/** Descriptor checks prevent swapped links, shared files, and special files from becoming evidence inputs or outputs. */
function privateFile(stat) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== SINGLE_LINK_COUNT || (stat.mode & MODE_MASK) !== PRIVATE_FILE_MODE) {
    throw new Error(UNSAFE_FILE_ERROR)
  }
}

/** Keep every original receipt plus the latest alias without normalizing malformed JSON or its bytes. */
export function saveProfilingEvidence(folder, contents, name) {
  privateDirectory(folder)
  const paths = []
  if (name !== undefined) {
    if (!REPORT_FILENAME.test(name)) throw new Error(INVALID_FILENAME_ERROR)
    const directory = join(folder, EVIDENCE_DIRECTORY)
    try { mkdirSync(directory, { mode: PRIVATE_DIRECTORY_MODE }) } catch (error) {
      if (error.code !== EXISTING_PATH_CODE) throw error
    }
    privateDirectory(directory)
    paths.push(join(directory, name))
  }
  paths.push(join(folder, EVIDENCE_LATEST))
  for (const path of paths) {
    const fd = openSync(path, WRITE_FLAGS, PRIVATE_FILE_MODE)
    try {
      privateFile(fstatSync(fd))
      // Truncation must wait until the opened file, not only its pathname, passes the safety checks.
      ftruncateSync(fd, FILE_START)
      writeFileSync(fd, contents)
    } finally { closeSync(fd) }
  }
}

/** Reports must describe observed events, but rejected receipts must outlive scratch-home cleanup too. */
export function verifyProfilingEvidence(home, expected, raw, exitCode, evidence, initialSessionId) {
  const directory = join(home, ...REPORT_PARTS)
  let names = []
  try {
    // Check each owned parent before listing; a safe-looking leaf must not redirect reads into another home.
    let parent = home
    for (const part of ['', ...REPORT_PARTS]) {
      parent = join(parent, part)
      const stat = lstatSync(parent)
      if (!stat.isDirectory() || stat.isSymbolicLink() || (parent === directory && (stat.mode & MODE_MASK) !== PRIVATE_DIRECTORY_MODE)) {
        throw new Error(DIRECTORY_PRIVACY_ERROR)
      }
    }
    names = readdirSync(directory).filter(name => name.endsWith(REPORT_SUFFIX))
  } catch (error) {
    // A refused output directory is the intentional write-failure scenario; never inspect its target.
    if (error.code !== MISSING_DIRECTORY_CODE && !(expected?.failure && error.message === DIRECTORY_PRIVACY_ERROR)) throw error
  }
  names.sort((left, right) => left.slice(-TIMESTAMP_SUFFIX_LENGTH).localeCompare(right.slice(-TIMESTAMP_SUFFIX_LENGTH)))
  const reports = []
  let unsafeReport
  for (const name of names) {
    const file = join(directory, name)
    let contents
    try {
      if (!REPORT_FILENAME.test(name)) throw new Error(INVALID_FILENAME_ERROR)
      privateFile(lstatSync(file))
      const fd = openSync(file, READ_FLAGS)
      try {
        privateFile(fstatSync(fd))
        contents = readFileSync(fd)
      } finally { closeSync(fd) }
    } catch (error) {
      // One unsafe candidate must not erase safe siblings that explain a count or schema failure.
      unsafeReport ??= error
      continue
    }
    evidence(contents, name)
    reports.push({ name, file, contents })
  }
  if (unsafeReport) throw unsafeReport
  if (expected === false) {
    if (names.length !== EMPTY_REPORT_COUNT) throw new Error(FLAGLESS_REPORT_ERROR)
    return
  }
  if (expected.failure) {
    if (names.length !== EMPTY_REPORT_COUNT || !raw.includes(REPORT_FAILURE)) {
      throw new Error(WRITE_FAILURE_ERROR)
    }
    evidence(Buffer.from(JSON.stringify({ status: WRITE_FAILURE_STATUS, exitCode }) + '\n'))
    return
  }
  if (names.length !== (expected.count ?? DEFAULT_REPORT_COUNT)) throw new Error(COUNT_ERROR + names.length)
  const { name, file, contents: bytes } = reports.at(LATEST_REPORT_INDEX)
  const contents = bytes.toString(ENCODING)
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
  for (const expectedPhase of expected.phaseCounts ?? []) {
    // Count incomplete and failed spans too: a completed duplicate must not conceal an extra lifecycle attempt.
    const count = report.phases.filter(row => row.name === expectedPhase.name && row.category === expectedPhase.category).length
    if (count !== expectedPhase.count) throw new Error(PHASE_COUNT_ERROR + expectedPhase.category + CATEGORY_PHASE_SEPARATOR + expectedPhase.name + ': ' + count)
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
}
