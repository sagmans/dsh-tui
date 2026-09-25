import { type Candidate, offerablePath, depthOf } from './file-search.ts'
import { spawn } from 'node:child_process'
import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'

/**
 * Which files the workspace holds, asked of Git first and walked otherwise.
 *
 * Enumeration is an effect, not a policy: the listing subprocess, its timeout,
 * and the bounded walk that answers when Git is absent or refuses, all change
 * for reasons the token grammar the reader types into does not.
 */

/** How long git is given before the menu stops waiting for its answer. */
const GIT_TIMEOUT_MS = 3_000

/**
 * The git listing that answers for a workspace.
 *
 * Tracked files and untracked ones that git would add, with ignored paths left
 * out: that is the set the agent itself works on, so a suggestion can never
 * name a build artifact or a secret the repository deliberately ignores. The
 * stage information is asked for too, because it is the only place the listing
 * says which entries are symbolic links.
 *
 * The two sets are asked for apart: an indexed record carries metadata before a
 * tab and an untracked one is a bare path, so a tab inside an untracked name
 * would otherwise look like metadata and hand back a path nobody wrote.
 */
const GIT_TRACKED_ARGUMENTS = ['ls-files', '-s', '-z', '--cached']

const GIT_UNTRACKED_ARGUMENTS = ['ls-files', '-z', '--others', '--exclude-standard']

/** The index modes that name something other than an ordinary file. */
const GIT_SYMLINK_MODE = '120000'

const GIT_SUBMODULE_MODE = '160000'

const GIT_MODE_LENGTH = 6

/** Git's way of saying the directory was never under version control. */
const GIT_EXIT_FATAL = 128

const GIT_NOT_A_REPOSITORY = /not a git repository/i

const GIT_ERROR_LIMIT = 4_096

/** The marker git leaves at the root of a worktree, which a walk must respect. */
const GIT_MARKER = '.git'

/** A path that cannot climb further than this many parents is not mounted anywhere real. */
const MAX_PARENT_DIRECTORIES = 40

/** One path git listed, with the type its index mode or the filesystem reports. */
interface GitEntry {
  readonly path: string
  readonly symlink: boolean
  readonly submodule: boolean
  readonly untracked: boolean
}

/** What git's answer means for the listing, including the ways it can refuse. */
type GitListing =
  | { readonly kind: 'listed'; readonly entries: readonly GitEntry[] }
  | { readonly kind: 'not-a-repository' }
  | { readonly kind: 'failed' }

/**
 * Directories a plain walk never descends into.
 *
 * These hold build output and caches rather than anything a reader attaches,
 * and one of them can dwarf the real tree.
 */
const SKIP_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  '.cache',
  '.next',
  '.turbo',
  'dist',
  'build',
  'coverage',
  'target',
])

/** Caps that keep a walk over a home directory from stalling the editor. */
const MAX_WALK_ENTRIES = 20_000

const MAX_WALK_DEPTH = 12

/**
 * The rows of a workspace, from git when it owns the directory and from a walk
 * when it does not.
 */
export async function listWorkspaceFiles(cwd: string, signal: AbortSignal): Promise<readonly Candidate[]> {
  if (signal.aborted) return []
  const listing = await gitFiles(cwd, signal)
  if (signal.aborted) return []
  if (listing.kind === 'listed') return await candidatesFrom(cwd, listing.entries, signal)
  // A tree a marker claims is a tree whose ignore-files must hold, whether git
  // owns it, lost it, or could not read it: a walk here would offer exactly the
  // paths those files keep out. Only a directory no marker reaches above may be
  // walked, and there nothing is being ignored in the first place.
  if (await hasGitMarker(cwd)) return []
  return await walkFiles(cwd, signal)
}

/**
 * Whether git owns this directory, or one above it, without asking git itself.
 *
 * A marker is the name itself, even when it is a link whose target is gone:
 * git reads that link, so this has to see it too. A stat that fails for any
 * reason but absence, and a climb that runs out of levels before a filesystem
 * root, both leave the question open — and an open question is answered by
 * refusing to walk, because a walk offers the very paths an ignore-file is
 * there to keep out.
 */
async function hasGitMarker(cwd: string): Promise<boolean> {
  let directory = cwd
  for (let level = 0; level < MAX_PARENT_DIRECTORIES; level += 1) {
    try {
      await lstat(join(directory, GIT_MARKER))
      return true
    } catch (error) {
      if (!isAbsent(error)) return true
    }
    const parent = dirname(directory)
    if (parent === directory) return false
    directory = parent
  }
  return true
}

/** Whether a stat failed because nothing carries that name. */
function isAbsent(error: unknown): boolean {
  const code = (error as { readonly code?: unknown } | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** One git question, and what its answer allows a caller to conclude. */
type GitAnswer =
  | { readonly kind: 'listed'; readonly records: readonly string[] }
  | { readonly kind: 'not-a-repository' }
  | { readonly kind: 'failed' }

/** Git's answer for a workspace, from the two listings a suggestion set needs. */
async function gitFiles(cwd: string, signal: AbortSignal): Promise<GitListing> {
  if (signal.aborted) return { kind: 'failed' }
  const [tracked, untracked] = await Promise.all([
    runGit(cwd, GIT_TRACKED_ARGUMENTS, signal),
    runGit(cwd, GIT_UNTRACKED_ARGUMENTS, signal),
  ])
  if (tracked.kind === 'listed' && untracked.kind === 'listed') {
    return {
      kind: 'listed',
      entries: [...parseTrackedListing(tracked.records), ...parseUntrackedListing(untracked.records)],
    }
  }
  if (tracked.kind === 'not-a-repository' || untracked.kind === 'not-a-repository') return { kind: 'not-a-repository' }
  return { kind: 'failed' }
}

/** Ask git one question, and read its exit as a meaning rather than a number. */
async function runGit(cwd: string, args: readonly string[], signal: AbortSignal): Promise<GitAnswer> {
  if (signal.aborted) return { kind: 'failed' }
  return await new Promise<GitAnswer>(resolve => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (value: GitAnswer): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const child = spawn('git', [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const onAbort = (): void => {
      child.kill('SIGKILL')
      finish({ kind: 'failed' })
    }
    signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ kind: 'failed' })
    }, GIT_TIMEOUT_MS)
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      // Only the refusal is read; a repository cannot be diagnosed from here,
      // and an unbounded buffer would grow with git's chatter.
      if (stderr.length < GIT_ERROR_LIMIT) stderr += chunk
    })
    child.on('error', () => finish({ kind: 'failed' }))
    child.on('close', code => {
      if (code === 0) {
        finish({ kind: 'listed', records: stdout.split('\0') })
        return
      }
      if (code === GIT_EXIT_FATAL && GIT_NOT_A_REPOSITORY.test(stderr)) {
        finish({ kind: 'not-a-repository' })
        return
      }
      finish({ kind: 'failed' })
    })
  })
}

/**
 * Read the indexed listing.
 *
 * An entry arrives as its mode, its object, and its stage, then a tab and the
 * path. Only the first tab separates, so a name that carries one is read whole.
 * A path can appear once per merge stage, and the map keeps the last, so a
 * conflicted file is not offered three times.
 */
function parseTrackedListing(records: readonly string[]): readonly GitEntry[] {
  const byPath = new Map<string, GitEntry>()
  for (const record of records) {
    if (record === '') continue
    const tab = record.indexOf('\t')
    // Nothing but metadata precedes the tab, so a record without one is not a
    // line git wrote; reading it as a path would invent a name.
    if (tab < 0) continue
    const mode = record.slice(0, GIT_MODE_LENGTH)
    const path = record.slice(tab + 1)
    if (path === '') continue
    byPath.set(path, {
      path,
      symlink: mode === GIT_SYMLINK_MODE,
      submodule: mode === GIT_SUBMODULE_MODE,
      untracked: false,
    })
  }
  return [...byPath.values()]
}

/** Read the untracked listing, which carries no metadata to mistake for a path. */
function parseUntrackedListing(records: readonly string[]): readonly GitEntry[] {
  const entries: GitEntry[] = []
  for (const record of records) {
    if (record === '') continue
    entries.push({ path: record, symlink: false, submodule: false, untracked: true })
  }
  return entries
}

/**
 * Turn git's entries into rows, deriving the directories they imply.
 *
 * Git lists files only, but a reader typing a path prefix wants to open a
 * directory as readily as a file. A link is offered as whatever it names, and
 * only while that target stays in the workspace: the reader would otherwise
 * attach a path the menu never showed them.
 */
async function candidatesFrom(
  root: string,
  entries: readonly GitEntry[],
  signal: AbortSignal,
): Promise<readonly Candidate[]> {
  const canonicalRoot = await canonicalOrUndefined(root)
  if (canonicalRoot === undefined) return []
  const files = new Map<string, Candidate>()
  const directories = new Set<string>()
  for (const entry of entries) {
    // Every entry costs a stat at least, so a scan whose deadline passed stops
    // here rather than walking the rest of a tree nobody waits for.
    if (signal.aborted) return []
    if (!offerablePath(entry.path)) continue
    const linked = entry.symlink || (entry.untracked && await isSymlink(root, entry.path))
    let isDirectory = entry.submodule
    if (linked) {
      const target = await linkedTarget(canonicalRoot, join(root, entry.path))
      if (target === undefined) continue
      isDirectory = target
    }
    files.set(entry.path, { path: entry.path, isDirectory })
    addParentDirectories(directories, entry.path)
  }
  const rows = new Map<string, Candidate>()
  for (const directory of directories) rows.set(directory, { path: directory, isDirectory: true })
  for (const candidate of files.values()) {
    if (!rows.has(candidate.path)) rows.set(candidate.path, candidate)
  }
  return [...rows.values()].sort((left, right) => left.path.localeCompare(right.path))
}

/** Every path implies the directories above it, which a reader may open. */
function addParentDirectories(directories: Set<string>, path: string): void {
  for (let at = path.indexOf('/'); at >= 0; at = path.indexOf('/', at + 1)) {
    directories.add(path.slice(0, at))
  }
}

/** Whether the entry is a link when the index did not say, which is the untracked case. */
async function isSymlink(root: string, path: string): Promise<boolean> {
  try {
    return (await lstat(join(root, path))).isSymbolicLink()
  } catch {
    // A path that vanished between the listing and the stat is offered as the
    // plain file git saw; there is no link left to follow.
    return false
  }
}

/**
 * Whether a link names something the workspace holds, and whether that is a
 * directory.
 */
async function linkedTarget(canonicalRoot: string, path: string): Promise<boolean | undefined> {
  try {
    const target = await realpath(path)
    const inside = relative(canonicalRoot, target)
    if (inside !== '' && (inside.startsWith('..') || isAbsolute(inside))) return undefined
    return (await stat(target)).isDirectory()
  } catch {
    return undefined
  }
}

export async function canonicalOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await realpath(path)
  } catch {
    return undefined
  }
}

/** Walk a tree git does not own, breadth first, stopping at the caps above. */
export async function walkFiles(cwd: string, signal: AbortSignal): Promise<readonly Candidate[]> {
  if (signal.aborted) return []
  const canonicalRoot = await canonicalOrUndefined(cwd)
  if (canonicalRoot === undefined) return []
  const found: Candidate[] = []
  const queue: string[] = ['']
  while (queue.length > 0) {
    if (signal.aborted) return []
    const directory = queue.shift() ?? ''
    let entries
    try {
      entries = await readdir(directory === '' ? cwd : join(cwd, directory), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (found.length >= MAX_WALK_ENTRIES) return found
      const path = directory === '' ? entry.name : directory + '/' + entry.name
      if (!offerablePath(path)) continue
      if (entry.isSymbolicLink()) {
        const target = await linkedTarget(canonicalRoot, join(cwd, path))
        if (target === undefined) continue
        // A link is offered as the thing it names and never followed: following
        // one would let a single entry stand in for a tree outside the workspace.
        found.push({ path, isDirectory: target })
        continue
      }
      if (!entry.isDirectory()) {
        found.push({ path, isDirectory: false })
        continue
      }
      if (SKIP_DIRECTORIES.has(entry.name)) continue
      found.push({ path, isDirectory: true })
      if (depthOf(path) < MAX_WALK_DEPTH) queue.push(path)
    }
  }
  return found
}
