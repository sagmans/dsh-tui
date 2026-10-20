#!/usr/bin/env node
/**
 * pi-tui compatibility range guard.
 *
 * The bundle ships with pi-tui pinned to the floor of its supported range, and
 * every gate runs on that pin. A release inside the range can still change what
 * the surface draws (pi-tui 1.2 moved the cursor cell, 1.1 swapped Home/End), so
 * the pre-push hook also runs the gates on the newest release in the range. That
 * run installs from its own committed manifest and lockfile in compat/pi-tui, so
 * it is as reproducible as the main install and obeys the same release-age policy.
 *
 * Modes:
 *   check   the compat manifest is the root manifest with only the pi-tui spec
 *           changed, and that spec is a range from the root pin up to just below
 *           the next minor's first prerelease
 *   report  after a compat install: name the resolved release, and warn when a
 *           newer release in the range has passed the release-age window
 *   lock    rewrite the compat manifest and lockfile from the root ones, resolving
 *           pi-tui to the newest release in the range the release-age policy allows
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PACKAGE = '@earendil-works/pi-tui'
const COMPAT_DIR = join(ROOT, 'compat', 'pi-tui')
const MANIFEST = 'package.json'
const LOCKFILE = 'pnpm-lock.yaml'
const WORKSPACE = 'pnpm-workspace.yaml'
const REGISTRY = 'https://registry.npmjs.org/'
// The ceiling names the next minor's lowest prerelease, so the range admits no
// build of that line, final or prerelease, under either prerelease reading.
const RANGE_PATTERN = /^>=(\d+\.\d+\.\d+) <(\d+\.\d+)\.0-0$/u
const RELEASE_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/u
const MINUTE_MS = 60_000

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const fail = (message) => {
  console.error('pi-tui-compat: ' + message)
  process.exit(1)
}

/** Release triples only: prereleases never count as the newest supported release. */
function releaseParts(version) {
  const match = RELEASE_PATTERN.exec(version)
  return match === null ? null : match.slice(1).map(Number)
}

function compareParts(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

/** The declared range, split into its floor release and its ceiling line. */
function parseRange(spec) {
  const match = RANGE_PATTERN.exec(spec ?? '')
  if (match === null) {
    fail('compat range must read ">=<root pin> <X.Y.0-0", found ' + String(spec))
  }
  return { floor: match[1], ceiling: match[2].split('.').map(Number).concat(0) }
}

function inRange(version, range) {
  const parts = releaseParts(version)
  return parts !== null
    && compareParts(parts, releaseParts(range.floor)) >= 0
    && compareParts(parts, range.ceiling) < 0
}

/** The root manifest with the pi-tui spec replaced, the shape the compat manifest must keep. */
function expectedCompatManifest(spec) {
  const manifest = readJson(join(ROOT, MANIFEST))
  manifest.dependencies[PACKAGE] = spec
  return manifest
}

function check() {
  const root = readJson(join(ROOT, MANIFEST))
  const compat = readJson(join(COMPAT_DIR, MANIFEST))
  const spec = compat.dependencies?.[PACKAGE]
  const range = parseRange(spec)
  // The main gates prove the floor, so the floor must be exactly what ships.
  if (range.floor !== root.dependencies?.[PACKAGE]) {
    fail('compat range floor ' + range.floor + ' must equal the root pin ' + String(root.dependencies?.[PACKAGE]))
  }
  if (compareParts(releaseParts(range.floor), range.ceiling) >= 0) {
    fail('compat range ' + spec + ' is empty')
  }
  // Any other drift means the compat lockfile tests a dependency set that no
  // longer ships; `lock` rebuilds both files from the root ones.
  if (JSON.stringify(compat) !== JSON.stringify(expectedCompatManifest(spec))) {
    fail('compat/pi-tui/package.json is stale; run `node tools/pi-tui-compat.mjs lock`')
  }
  console.log('pi-tui-compat: range ' + spec + ' declared, floor matches the root pin')
}

/** The workspace release-age window, in minutes, so the notice follows the same policy as install. */
function minimumReleaseAge() {
  const match = /^minimumReleaseAge:\s*(\d+)\s*$/mu.exec(readFileSync(join(ROOT, WORKSPACE), 'utf8'))
  return match === null ? 0 : Number(match[1])
}

async function report() {
  const spec = readJson(join(COMPAT_DIR, MANIFEST)).dependencies[PACKAGE]
  const range = parseRange(spec)
  const resolved = readJson(join(ROOT, 'node_modules', PACKAGE, MANIFEST)).version
  if (!inRange(resolved, range)) fail('installed ' + PACKAGE + ' ' + resolved + ' lies outside ' + spec)
  console.log('pi-tui-compat: range ' + spec + ' resolved ' + resolved)

  // A stale lockfile keeps testing an older release; say so, but do not block a
  // push on a registry read or on a release published after the last `lock`.
  let times
  try {
    const response = await fetch(REGISTRY + PACKAGE.replace('/', '%2f'))
    if (!response.ok) throw new Error('HTTP ' + response.status)
    times = (await response.json()).time ?? {}
  } catch (error) {
    console.warn('pi-tui-compat: registry read failed (' + error.message + '); newest-release check skipped')
    return
  }
  const cutoff = Date.now() - minimumReleaseAge() * MINUTE_MS
  const newest = Object.keys(times)
    .filter(version => inRange(version, range) && Date.parse(times[version]) <= cutoff)
    .sort((left, right) => compareParts(releaseParts(left), releaseParts(right)))
    .at(-1)
  if (newest !== undefined && newest !== resolved) {
    console.warn('pi-tui-compat: WARNING: ' + newest + ' is the newest release in ' + spec
      + ' past the release-age window, but the compat lockfile resolves ' + resolved
      + '; run `node tools/pi-tui-compat.mjs lock` and commit the result')
  }
}

function lock() {
  const spec = readJson(join(COMPAT_DIR, MANIFEST)).dependencies[PACKAGE]
  parseRange(spec)
  const manifest = JSON.stringify(expectedCompatManifest(spec), null, 2) + '\n'
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-tui-pi-compat-'))
  try {
    // Start from the root lockfile so every other dependency stays exactly where
    // the main gates tested it; only pi-tui and what it pulls in move.
    copyFileSync(join(ROOT, LOCKFILE), join(scratch, LOCKFILE))
    copyFileSync(join(ROOT, WORKSPACE), join(scratch, WORKSPACE))
    writeFileSync(join(scratch, MANIFEST), manifest)
    const pnpm = (args) => execFileSync('pnpm', [...args, '--lockfile-only', '--ignore-scripts'], { cwd: scratch, stdio: 'inherit' })
    // `update` re-resolves to the newest release the policy allows but rewrites
    // the spec, so the manifest is restored and the lockfile re-synced to it.
    pnpm(['update', PACKAGE])
    writeFileSync(join(scratch, MANIFEST), manifest)
    pnpm(['install'])
    copyFileSync(join(scratch, LOCKFILE), join(COMPAT_DIR, LOCKFILE))
    writeFileSync(join(COMPAT_DIR, MANIFEST), manifest)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  console.log('pi-tui-compat: compat/pi-tui rebuilt for ' + spec)
}

const MODES = { check, report, lock }
const mode = MODES[process.argv[2]]
if (mode === undefined) fail('usage: node tools/pi-tui-compat.mjs check|report|lock')
await mode()
