import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SKILLS_ROOT = join(PACKAGE_ROOT, '.agents', 'skills')
/** The user skill root, spelled once: the installer writes it and the drift check reads it. */
const AGENTS_DIRECTORY = '.agents'
const SKILLS_DIRECTORY = 'skills'
/** A bundled helper must keep its execute bit once the archive has stripped it. */
const HELPER_EXTENSIONS = ['.sh', '.mjs']
const EXECUTABLE_MODE = 0o755
/** The command a drift notice names, so the line it prints is the line that runs. */
export const SKILL_UPDATE_COMMAND = 'dsh --profile tui install-skills --update'
/** Separator the surface's own notices use, so a drift line reads like the rest. */
const NOTICE_SEPARATOR = ' · '

function installedSkillsRoot(home: string): string {
  return join(home, AGENTS_DIRECTORY, SKILLS_DIRECTORY)
}

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
export function bundledSkillNames(bundled: string = SKILLS_ROOT): string[] {
  const root = lstatSync(bundled)
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error(`invalid bundled skills: ${bundled}`)
  const names = readdirSync(bundled, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
    .map(entry => entry.name)
    .sort()
  if (names.length === 0) throw new Error(`no bundled skills: ${bundled}`)
  return names
}

/** Every regular file a skill directory carries, keyed by its relative path. */
function skillFiles(root: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>()
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : prefix + '/' + entry.name
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(path, relative)
        continue
      }
      // A symlinked member is not content this package shipped, and following
      // one would read whatever it happens to point at.
      if (!entry.isFile()) continue
      files.set(relative, readFileSync(path))
    }
  }
  walk(root, '')
  return files
}

/**
 * The installed copies that no longer match what this package ships.
 *
 * Content only, over the bundled file set. The installer chmods its own
 * helpers, so a mode difference is its doing rather than drift, and a file a
 * reader added beside a skill is theirs: one startup line can explain neither,
 * and a line that cries wolf gets read past when it matters.
 */
export function driftedSkillNames(home: string = homedir(), bundled: string = SKILLS_ROOT): string[] {
  const skills = installedSkillsRoot(home)
  return bundledSkillNames(bundled).filter(name => {
    const destination = join(skills, name)
    const entry = lstatSync(destination, { throwIfNoEntry: false })
    // Never installed is not drift - a first install is that command's own
    // prompt - and a symlinked copy is one the installer refuses to replace.
    if (entry === undefined || entry.isSymbolicLink() || !entry.isDirectory()) return false
    const installed = skillFiles(destination)
    for (const [path, content] of skillFiles(join(bundled, name))) {
      const current = installed.get(path)
      if (current === undefined || !current.equals(content)) return true
    }
    return false
  })
}

/**
 * The one line a startup can spare for an installed skill this build has moved
 * past, or `undefined` when every installed copy still matches.
 *
 * Silence on any failure: a notice is a courtesy, and an unreadable home must
 * not cost a reader the session they launched.
 */
export function describeSkillDrift(home: string = homedir(), bundled: string = SKILLS_ROOT): string | undefined {
  try {
    const drifted = driftedSkillNames(home, bundled)
    if (drifted.length === 0) return undefined
    return `bundled skills changed since they were installed: ${drifted.join(NOTICE_SEPARATOR)}`
      + `${NOTICE_SEPARATOR}run ${SKILL_UPDATE_COMMAND}`
  } catch {
    return undefined
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
  ensureDirectory(join(home, AGENTS_DIRECTORY))
  const skills = installedSkillsRoot(home)
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
