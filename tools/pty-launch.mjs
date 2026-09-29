import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { problems } from '../.agents/skills/dsh-tui-dogfood/scripts/clone-links.mjs'

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * The releases a dogfood run may be driven against.
 *
 * A dogfood run proves the surface against a release the gates passed, and more
 * than one line is verified at a time: the compatible range spans two prerelease
 * lines, and the host rows mount different packages on each, so both have to be
 * driven. The list is read from the manifest the matrix gate checks, which is the
 * one place that pair is kept.
 */
function verifiedReleases() {
  const manifest = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'))
  const releases = Object.keys(manifest?.dsh?.compatibility?.dshReleases ?? {})
  if (releases.length === 0) {
    throw new Error('pty-drive: the manifest names no verified dsh release in dsh.compatibility.dshReleases')
  }
  return releases
}

function contains(parent, path) {
  const remainder = relative(parent, path)
  return remainder === '' || (remainder !== '..' && !remainder.startsWith('..' + sep) && !isAbsolute(remainder))
}

/**
 * The environment a surface gets when a tool starts it, rather than Herdr.
 *
 * Herdr exports its pane coordinates into every process it starts, and a
 * surface that inherits them claims that pane's agent row for the test run and
 * hands it back on the way out — which takes the row away from the agent really
 * running in the pane. Stripping the coordinates is what keeps a reproduction
 * from touching the pane it borrows.
 */
export function barePaneEnv(base = process.env) {
  return Object.fromEntries(Object.entries(base).filter(([name]) => !name.startsWith('HERDR_')))
}

/** Keep test writes away from the live home, including symlinked and parent paths. */
export function preparePtyLaunch({ home, launcher = '' }) {
  if (!home) throw new Error('pty-drive: --home must name an existing isolated directory')
  let selectedHome
  try {
    selectedHome = realpathSync(home)
    if (!statSync(selectedHome).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new Error('pty-drive: --home must name an existing isolated directory')
  }
  const userHome = realpathSync(homedir())
  const liveHomePath = join(userHome, '.dsh')
  const liveHome = existsSync(liveHomePath) ? realpathSync(liveHomePath) : liveHomePath
  if (contains(selectedHome, userHome) || contains(liveHome, selectedHome) || contains(selectedHome, liveHome)) {
    throw new Error('pty-drive: --home must not overlap the live home')
  }
  const unsafe = problems(selectedHome, liveHome)
  if (unsafe.length > 0) throw new Error('pty-drive: --home has unsafe symlink or hardlink: ' + unsafe[0])

  const command = launcher === '' ? 'dsh' : process.execPath
  const argsPrefix = launcher === '' ? [] : [launcher]
  // A version probe can initialize settings, so it gets its own disposable home.
  const probeHome = mkdtempSync(join(selectedHome, '.dsh-pty-version-'))
  let result
  try {
    result = spawnSync(command, [...argsPrefix, '--version'], {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...barePaneEnv(), HOME: probeHome, DSH_HOME: probeHome },
    })
  } finally {
    rmSync(probeHome, { recursive: true, force: true })
  }
  // Reject links created by the candidate while it reported its version.
  const unsafeAfterProbe = problems(selectedHome, liveHome)
  if (unsafeAfterProbe.length > 0) throw new Error('pty-drive: --home has unsafe symlink or hardlink: ' + unsafeAfterProbe[0])
  if (result.error || result.status !== 0) {
    throw new Error('pty-drive: installed dsh launcher is unavailable or failed --version')
  }
  const version = result.stdout.trim()
  const releases = verifiedReleases()
  if (!releases.includes(version)) {
    throw new Error('pty-drive: launcher must report a verified release (' + releases.join(', ') + '), got ' + version)
  }
  return { home: selectedHome, cwd: PROJECT_ROOT, command, argsPrefix }
}
