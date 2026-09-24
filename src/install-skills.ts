import { chmodSync, cpSync, lstatSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SKILL_NAME = 'dsh-tui-dogfood'
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SKILL_SOURCE = join(PACKAGE_ROOT, '.agents', 'skills', SKILL_NAME)
const HELPER_FILENAME = 'run-plugin-from-worktree.sh'
const EXECUTABLE_MODE = 0o755

/** Avoid writing through a pre-existing symlink into an unexpected directory. */
function ensureDirectory(path: string): void {
  try {
    const entry = lstatSync(path)
    if (entry.isSymbolicLink()) throw new Error(`refusing symbolic link: ${path}`)
    if (!entry.isDirectory()) throw new Error(`not a directory: ${path}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    mkdirSync(path)
  }
}

/** Explicitly copy the package's skill without replacing a user's copy. */
export function installBundledSkill(home: string = homedir()): string {
  const bundled = lstatSync(SKILL_SOURCE)
  if (!bundled.isDirectory() || bundled.isSymbolicLink()) {
    throw new Error(`invalid bundled skill: ${SKILL_SOURCE}`)
  }
  ensureDirectory(home)
  const agents = join(home, '.agents')
  ensureDirectory(agents)
  const skills = join(agents, 'skills')
  ensureDirectory(skills)

  const destination = join(skills, SKILL_NAME)
  try {
    mkdirSync(destination)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`skill already exists: ${destination}`)
    }
    throw error
  }

  // Keep a failed copy visible rather than silently replacing it on the next run.
  for (const entry of readdirSync(SKILL_SOURCE)) {
    cpSync(join(SKILL_SOURCE, entry), join(destination, entry), { recursive: true, force: false, errorOnExist: true })
  }

  // npm archives regular package files without execute bits, even when the checkout has them.
  const scripts = join(destination, 'scripts')
  const scriptsEntry = lstatSync(scripts)
  if (!scriptsEntry.isDirectory() || scriptsEntry.isSymbolicLink()) {
    throw new Error(`invalid bundled skill scripts: ${scripts}`)
  }
  const helper = join(scripts, HELPER_FILENAME)
  const helperEntry = lstatSync(helper)
  if (!helperEntry.isFile() || helperEntry.isSymbolicLink() || helperEntry.nlink !== 1) {
    throw new Error(`invalid bundled skill helper: ${helper}`)
  }
  chmodSync(helper, EXECUTABLE_MODE)
  return destination
}
