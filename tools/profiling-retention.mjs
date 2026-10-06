/** Rejected real-run receipts must remain diagnosable after their scratch homes disappear. */
import assert from 'node:assert/strict'
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { saveProfilingEvidence, verifyProfilingEvidence } from './profiling-evidence.mjs'

const RETENTION_DIRECTORY = 'profiling-retention'
const REPORT_DIRECTORY = 'profiling'
const LATEST_REPORT = 'profiling.json'
const TERMINAL_ARTIFACT = 'terminal.ansi'
const HOME_DIRECTORY = 'home'
const REPORT_PARTS = ['profiles', 'tui', REPORT_DIRECTORY]
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const PUBLIC_FILE_MODE = 0o644
const MODE_MASK = 0o777
const ENCODING = 'utf8'
const EXIT_SUCCESS = 0
const FIRST_REPORT = 0
const EXPECTED_REPORTS = 1
const INVALID_NUMBER = -1
const DUPLICATE_PREFIX = 'duplicate_'
const REPORT_PATH = /dsh-tui profiling: [^\r\n]+/u
const REPORT_PREFIX = 'dsh-tui profiling: '
const MALFORMED_BYTES = Buffer.from([0x7b, 0x0a, 0xff])
const EXTRA_WHITESPACE = '\n \t\n'
const MISSING_RECEIPT = 'dogfood: rejected profiling receipt disappeared after cleanup'
const CHANGED_RECEIPT = 'dogfood: rejected profiling receipt bytes changed'
const MISSING_REJECTION = 'dogfood: expected profiling rejection did not occur'
const PRIVATE_CONTENT = 'profiling-retention-private-marker'
const SENTINEL = Buffer.from('scratch-only credential sentinel')
const SENTINEL_FILE = 'credential-sentinel'
const INVALID_FILENAME = 'credentials.json'
const DISPOSAL = { name: 'agent-disposal', category: 'shutdown' }
const SINGLE_DISPOSAL = [{ ...DISPOSAL, count: EXPECTED_REPORTS }]
const INCOMPLETE = 'incomplete'
const FAILED = 'failed'
const SOURCE_LINK = 'source-link'
const SOURCE_HARDLINK = 'source-hardlink'
const SOURCE_PUBLIC = 'source-public'
const SOURCE_DIRECTORY = 'source-directory'
const SOURCE_NAME = 'source-name'
const SOURCE_PARENT = 'source-parent'
const OUTPUT_LINK = 'output-link'
const OUTPUT_HARDLINK = 'output-hardlink'
const OUTPUT_PUBLIC = 'output-public'
const UNSAFE_CASES = [SOURCE_LINK, SOURCE_HARDLINK, SOURCE_PUBLIC, SOURCE_DIRECTORY, SOURCE_NAME, SOURCE_PARENT, OUTPUT_LINK, OUTPUT_HARDLINK, OUTPUT_PUBLIC]
const UNSAFE_ERROR = /private|filename|ELOOP|unsafe/u
const CASES = [
  { name: 'malformed', malformed: true, error: /JSON|Unexpected|Expected/u },
  { name: 'schema', invalidSchema: true, error: /invalid profiling schema/u },
  { name: 'timing', invalidTiming: true, error: /invalid profiling timing/u },
  { name: 'privacy', privateContent: true, expected: { excluded: [PRIVATE_CONTENT] }, error: /retained private draft content/u },
  { name: 'count', duplicate: true, expected: { count: EXPECTED_REPORTS }, error: /expected profiling reports, found 2/u },
  { name: 'flagless', expected: false, error: /flagless invocation wrote/u },
  { name: 'incomplete-disposal', duplicateStatus: INCOMPLETE, expected: { phaseCounts: SINGLE_DISPOSAL }, error: /profiling phase count/u },
  { name: 'failed-disposal', duplicateStatus: FAILED, expected: { phaseCounts: SINGLE_DISPOSAL }, error: /profiling phase count/u },
]

/** A runner rejection counts as proof only when the original report survives actual runner cleanup. */
export function verifyProfilingFailure(folder, error, expected) {
  assert.ok(error instanceof Error && error.message.startsWith(expected.message), error?.message ?? MISSING_REJECTION)
  assert.equal(existsSync(join(folder, HOME_DIRECTORY)), false)
  const latest = join(folder, LATEST_REPORT)
  assert.ok(existsSync(latest), MISSING_RECEIPT)
  const contents = readFileSync(latest)
  assert.equal(JSON.parse(contents.toString(ENCODING)).exit.code, expected.exitCode)
  assert.equal(lstatSync(latest).mode & MODE_MASK, PRIVATE_FILE_MODE)
  const directory = join(folder, REPORT_DIRECTORY)
  const names = readdirSync(directory)
  assert.equal(names.length, EXPECTED_REPORTS)
  assert.deepEqual(readFileSync(join(directory, names[FIRST_REPORT])), contents, CHANGED_RECEIPT)
}

/** The seed comes from this gate's actual TUI process, so receipt generation and retention share one proof. */
export function verifyProfilingRetention(folder) {
  const original = readFileSync(join(folder, LATEST_REPORT))
  const seed = JSON.parse(original.toString(ENCODING))
  const name = readdirSync(join(folder, REPORT_DIRECTORY))[FIRST_REPORT]
  const terminal = readFileSync(join(folder, TERMINAL_ARTIFACT), ENCODING)
  const allocation = join(folder, RETENTION_DIRECTORY)
  mkdirSync(allocation, { mode: PRIVATE_DIRECTORY_MODE })
  for (const scenario of CASES) {
    const evidence = join(allocation, scenario.name)
    const home = join(evidence, HOME_DIRECTORY)
    const directory = join(home, ...REPORT_PARTS)
    mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
    const report = structuredClone(seed)
    if (scenario.invalidTiming) report.timing.shutdownMs = INVALID_NUMBER
    if (scenario.invalidSchema) report.schemaVersion = INVALID_NUMBER
    if (scenario.privateContent) report.privateMarker = PRIVATE_CONTENT
    if (scenario.duplicateStatus) {
      const phase = report.phases.find(row => row.name === DISPOSAL.name && row.category === DISPOSAL.category)
      assert.ok(phase)
      report.phases.push({ ...phase, status: scenario.duplicateStatus,
        ...(scenario.duplicateStatus === INCOMPLETE ? { endMs: null, durationMs: null } : {}) })
    }
    // Noncanonical whitespace exposes accidental JSON normalization during failure capture.
    const contents = scenario.malformed ? MALFORMED_BYTES : Buffer.from(JSON.stringify(report) + EXTRA_WHITESPACE)
    const names = scenario.duplicate ? [name, DUPLICATE_PREFIX + name] : [name]
    for (const filename of names) writeFileSync(join(directory, filename), contents, { mode: PRIVATE_FILE_MODE })
    const raw = terminal.replace(REPORT_PATH, REPORT_PREFIX + join(directory, name))
    let rejection
    try {
      verifyProfilingEvidence(home, scenario.expected ?? {}, raw, EXIT_SUCCESS,
        (bytes, filename) => saveProfilingEvidence(evidence, bytes, filename))
    } catch (error) { rejection = error }
    finally { rmSync(home, { recursive: true }) }
    assert.match(rejection?.message ?? '', scenario.error)
    assert.equal(existsSync(home), false)
    const latest = join(evidence, LATEST_REPORT)
    assert.ok(existsSync(latest), MISSING_RECEIPT)
    assert.deepEqual(readFileSync(latest), contents, CHANGED_RECEIPT)
    assert.equal(lstatSync(latest).mode & MODE_MASK, PRIVATE_FILE_MODE)
    const retained = join(evidence, REPORT_DIRECTORY)
    assert.equal(lstatSync(retained).mode & MODE_MASK, PRIVATE_DIRECTORY_MODE)
    for (const filename of names) {
      const file = join(retained, filename)
      assert.deepEqual(readFileSync(file), contents, CHANGED_RECEIPT)
      assert.equal(lstatSync(file).mode & MODE_MASK, PRIVATE_FILE_MODE)
    }
  }
  for (const kind of UNSAFE_CASES) {
    const evidence = join(allocation, kind)
    const home = join(evidence, HOME_DIRECTORY)
    const directory = join(home, ...REPORT_PARTS)
    mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
    const secret = join(evidence, SENTINEL_FILE)
    writeFileSync(secret, SENTINEL, { mode: PRIVATE_FILE_MODE })
    writeFileSync(join(directory, name), original, { mode: PRIVATE_FILE_MODE })
    const unsafe = join(directory, DUPLICATE_PREFIX + name)
    const latest = join(evidence, LATEST_REPORT)
    if (kind === SOURCE_LINK) symlinkSync(secret, unsafe)
    if (kind === SOURCE_HARDLINK) linkSync(secret, unsafe)
    if (kind === SOURCE_PUBLIC) writeFileSync(unsafe, SENTINEL, { mode: PUBLIC_FILE_MODE })
    if (kind === SOURCE_DIRECTORY) mkdirSync(unsafe, { mode: PRIVATE_DIRECTORY_MODE })
    if (kind === SOURCE_NAME) writeFileSync(join(directory, INVALID_FILENAME), SENTINEL, { mode: PRIVATE_FILE_MODE })
    if (kind === SOURCE_PARENT) {
      rmSync(join(home, REPORT_PARTS[FIRST_REPORT]), { recursive: true })
      symlinkSync(evidence, join(home, REPORT_PARTS[FIRST_REPORT]))
    }
    if (kind === OUTPUT_LINK) symlinkSync(secret, latest)
    if (kind === OUTPUT_HARDLINK) linkSync(secret, latest)
    if (kind === OUTPUT_PUBLIC) writeFileSync(latest, SENTINEL, { mode: PUBLIC_FILE_MODE })
    let rejection
    try {
      const raw = terminal.replace(REPORT_PATH, REPORT_PREFIX + join(directory, name))
      verifyProfilingEvidence(home, {}, raw, EXIT_SUCCESS,
        (bytes, filename) => saveProfilingEvidence(evidence, bytes, filename))
    } catch (error) { rejection = error }
    finally { rmSync(home, { recursive: true }) }
    assert.match(rejection?.message ?? '', UNSAFE_ERROR)
    assert.deepEqual(readFileSync(secret), SENTINEL)
    assert.equal(existsSync(home), false)
    if (kind === SOURCE_PARENT) {
      assert.equal(existsSync(latest), false)
      continue
    }
    const retained = join(evidence, REPORT_DIRECTORY)
    assert.deepEqual(readdirSync(retained), [name])
    assert.deepEqual(readFileSync(join(retained, name)), original)
    const outputUnsafe = [OUTPUT_LINK, OUTPUT_HARDLINK, OUTPUT_PUBLIC].includes(kind)
    assert.deepEqual(readFileSync(latest), outputUnsafe ? SENTINEL : original)
  }
}
