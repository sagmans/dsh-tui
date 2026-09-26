import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { problems } from '../.agents/skills/dsh-tui-dogfood/scripts/clone-links.mjs'

const RELEASE_VERSION = '0.1.5-rc.3'
const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

function contains(parent, path) {
  const remainder = relative(parent, path)
  return remainder === '' || (remainder !== '..' && !remainder.startsWith('..' + sep) && !isAbsolute(remainder))
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
      env: { ...process.env, HOME: probeHome, DSH_HOME: probeHome },
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
  if (version !== RELEASE_VERSION) {
    throw new Error('pty-drive: launcher must report ' + RELEASE_VERSION + ', got ' + version)
  }
  return { home: selectedHome, cwd: PROJECT_ROOT, command, argsPrefix }
}
