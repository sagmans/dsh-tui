import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SKILL_NAME = 'dsh-tui-dogfood'
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SKILL_SOURCE = join(PACKAGE_ROOT, '.agents', 'skills', SKILL_NAME)
const HELPER_FILENAME = 'run-plugin-from-worktree.sh'
const EXECUTABLE_MODE = 0o755
const UPDATE_PREFIX = `.${SKILL_NAME}-update-`

export class SkillAlreadyExistsError extends Error {
  constructor(readonly destination: string) {
    super(`skill already exists: ${destination}`)
  }
}

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

/** The archive strips execute bits, so set them only on a verified regular helper. */
function copyBundledSkill(destination: string): void {
  mkdirSync(destination)
  for (const entry of readdirSync(SKILL_SOURCE)) {
    cpSync(join(SKILL_SOURCE, entry), join(destination, entry), { recursive: true, force: false, errorOnExist: true })
  }
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
}

/** Stage updates before moving an existing user skill, and restore it if replacement fails. */
export function installBundledSkill(home: string = homedir(), update = false): string {
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
  const existing = lstatSync(destination, { throwIfNoEntry: false })
  if (existing === undefined) {
    try {
      copyBundledSkill(destination)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new SkillAlreadyExistsError(destination)
      }
      throw error
    }
    return destination
  }
  if (!update) throw new SkillAlreadyExistsError(destination)
  if (existing.isSymbolicLink()) throw new Error(`refusing symbolic link: ${destination}`)
  if (!existing.isDirectory()) throw new Error(`not a directory: ${destination}`)

  const workspace = mkdtempSync(join(skills, UPDATE_PREFIX))
  const staged = join(workspace, 'new')
  const backup = join(workspace, 'previous')
  let oldCopyMoved = false
  try {
    copyBundledSkill(staged)
    const current = lstatSync(destination)
    if (current.isSymbolicLink() || !current.isDirectory()) {
      throw new Error(`invalid existing skill: ${destination}`)
    }
    renameSync(destination, backup)
    oldCopyMoved = true
    try {
      const previous = lstatSync(backup)
      if (previous.isSymbolicLink() || !previous.isDirectory()) {
        throw new Error(`invalid existing skill: ${backup}`)
      }
      renameSync(staged, destination)
    } catch (error) {
      try {
        renameSync(backup, destination)
        oldCopyMoved = false
      } catch (restoreError) {
        throw new Error(`skill update failed; original remains at ${backup}; restore failed: ${String(restoreError)}`, { cause: error })
      }
      throw error
    }
    try {
      rmSync(workspace, { recursive: true })
    } catch (error) {
      throw new Error(`skill updated; backup cleanup failed at ${workspace}: ${String(error)}`, { cause: error })
    }
    return destination
  } catch (error) {
    // Never remove the backup if restoring the previous skill failed.
    if (!oldCopyMoved) rmSync(workspace, { recursive: true, force: true })
    throw error
  }
}
