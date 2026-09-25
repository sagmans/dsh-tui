import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SKILLS_ROOT = join(PACKAGE_ROOT, '.agents', 'skills')
/** A bundled helper must keep its execute bit once the archive has stripped it. */
const HELPER_EXTENSIONS = ['.sh', '.mjs']
const EXECUTABLE_MODE = 0o755

export class SkillAlreadyExistsError extends Error {
  constructor(readonly destination: string) {
    super(`skill already exists: ${destination}`)
  }
}

/**
 * The skills this package ships, read from the bundled directory rather than
 * listed: a skill a reader can see here is one `install-skills` installs, and
 * adding another never means editing the installer.
 */
export function bundledSkillNames(): string[] {
  const root = lstatSync(SKILLS_ROOT)
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error(`invalid bundled skills: ${SKILLS_ROOT}`)
  const names = readdirSync(SKILLS_ROOT, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
    .map(entry => entry.name)
    .sort()
  if (names.length === 0) throw new Error(`no bundled skills: ${SKILLS_ROOT}`)
  return names
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

/** The archive strips execute bits, so set them only on verified regular helpers. */
function restoreHelpers(destination: string): void {
  const scripts = join(destination, 'scripts')
  const entry = lstatSync(scripts, { throwIfNoEntry: false })
  if (entry === undefined) return
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`invalid bundled skill scripts: ${scripts}`)
  for (const name of readdirSync(scripts)) {
    if (!HELPER_EXTENSIONS.some(extension => name.endsWith(extension))) continue
    const helper = join(scripts, name)
    const file = lstatSync(helper)
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1) throw new Error(`invalid bundled skill helper: ${helper}`)
    chmodSync(helper, EXECUTABLE_MODE)
  }
}

function copyBundledSkill(name: string, destination: string): void {
  const source = join(SKILLS_ROOT, name)
  const bundled = lstatSync(source)
  if (!bundled.isDirectory() || bundled.isSymbolicLink()) throw new Error(`invalid bundled skill: ${source}`)
  mkdirSync(destination)
  try {
    for (const entry of readdirSync(source)) {
      cpSync(join(source, entry), join(destination, entry), { recursive: true, force: false, errorOnExist: true })
    }
    restoreHelpers(destination)
  } catch (error) {
    // A failed fresh copy must not turn the next unflagged install into a collision.
    try {
      rmSync(destination, { recursive: true, force: true })
    } catch (cleanupError) {
      throw new Error(`skill copy failed; partial copy may remain at ${destination}: ${String(cleanupError)}`, { cause: error })
    }
    throw error
  }
}

/** Refuse a destination that is not a plain directory before anything is staged. */
function requireReplaceable(destination: string): void {
  const entry = lstatSync(destination, { throwIfNoEntry: false })
  if (entry === undefined) return
  if (entry.isSymbolicLink()) throw new Error(`refusing symbolic link: ${destination}`)
  if (!entry.isDirectory()) throw new Error(`not a directory: ${destination}`)
}

/** Stage updates before moving an existing user skill, and restore it if replacement fails. */
function replaceBundledSkill(name: string, destination: string, skills: string): string {
  const workspace = mkdtempSync(join(skills, `.${name}-update-`))
  const staged = join(workspace, 'new')
  const backup = join(workspace, 'previous')
  let oldCopyMoved = false
  try {
    copyBundledSkill(name, staged)
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
  } catch (error) {
    if (oldCopyMoved) {
      try {
        renameSync(backup, destination)
      } catch {
        // The original is still at the backup path; the thrown error names it.
      }
    }
    try {
      rmSync(workspace, { recursive: true, force: true })
    } catch {
      // A leftover staging directory is reported by the error that caused it.
    }
    throw error
  }
  return destination
}

/** Install one bundled skill, or replace the installed copy when `update`. */
export function installBundledSkill(name: string, home: string = homedir(), update = false): string {
  return installBundledSkills(home, update, [name])[0]!
}

/**
 * Install every bundled skill, or exactly the named ones.
 *
 * Collisions are reported before the first copy, so a run either installs the
 * whole set or leaves the home as it found it.
 */
export function installBundledSkills(home: string = homedir(), update = false, names: readonly string[] = bundledSkillNames()): string[] {
  ensureDirectory(home)
  const agents = join(home, '.agents')
  ensureDirectory(agents)
  const skills = join(agents, 'skills')
  ensureDirectory(skills)
  const destinations = names.map(name => join(skills, name))
  for (const destination of destinations) {
    const existing = lstatSync(destination, { throwIfNoEntry: false })
    if (existing === undefined) continue
    if (!update) throw new SkillAlreadyExistsError(destination)
    requireReplaceable(destination)
  }
  return names.map((name, index) => {
    const destination = destinations[index]!
    if (lstatSync(destination, { throwIfNoEntry: false }) === undefined) {
      try {
        copyBundledSkill(name, destination)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new SkillAlreadyExistsError(destination)
        throw error
      }
      return destination
    }
    return replaceBundledSkill(name, destination, skills)
  })
}
