import { spawn } from 'node:child_process'
import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fuzzyScore } from './fuzzy.ts'

/** One row the workspace offers: a file, or a directory to open. */
export interface Candidate {
  readonly path: string
  readonly isDirectory: boolean
}

/**
 * What the reader is typing after an at-sign.
 *
 * The prefix is the exact run a completion replaces; the query is what the
 * search reads, without the at-sign, the opening quote, or the dot-slash habit
 * a reader brings from a shell.
 */
export interface AtToken {
  readonly prefix: string
  readonly query: string
  readonly quoted: boolean
}

/** Suggestions a completion menu is allowed to gather at once. */
export const SUGGESTION_LIMIT = 20

/** Where one token ends and the next begins, as a shell reader expects. */
const TOKEN_DELIMITERS = new Set([' ', '\t', '"', "'", '='])

const QUOTE = '"'
const ESCAPE = '\\'

/**
 * Read the at-token the cursor sits in, or undefined when it sits in none.
 *
 * The reader may be mid-sentence, so only the last token counts. A closed
 * quote ends a token: once the path is quoted whole there is nothing left to
 * complete, and continuing to offer rows would replace text the reader already
 * spelled out.
 */
export function atToken(text: string): AtToken | undefined {
  // A quote still open swallows the spaces inside it, so it is read before any
  // delimiter scan: otherwise the space inside a quoted path would look like
  // the end of the token.
  const quoteStart = openQuoteStart(text)
  if (quoteStart !== null && quoteStart > 0 && text[quoteStart - 1] === '@' && isTokenStart(text, quoteStart - 1)) {
    const raw = unescape(text.slice(quoteStart + 1))
    return { prefix: text.slice(quoteStart - 1), query: withoutDotSlash(raw), quoted: true }
  }
  let start = 0
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (TOKEN_DELIMITERS.has(text[index] ?? '')) {
      start = index + 1
      break
    }
  }
  const token = text.slice(start)
  if (!token.startsWith('@')) return undefined
  return { prefix: token, query: withoutDotSlash(token.slice(1)), quoted: false }
}

/**
 * The text a pick inserts for a path.
 *
 * A quoted token is the only shape that can carry a space, a quote, or the
 * other characters that end a token, so a path holding one is quoted even when
 * the reader never typed a quote themselves; the reader of a token undoes it.
 * A directory that had to be quoted stays open, because a quote closed behind
 * the cursor would leave nowhere to keep typing the path below it.
 */
export function atValue(path: string, quoted: boolean, open: boolean): string {
  if (!quoted && !needsQuoting(path)) return '@' + path
  const escaped = path.replaceAll(ESCAPE, ESCAPE + ESCAPE).replaceAll(QUOTE, ESCAPE + QUOTE)
  return '@' + QUOTE + escaped + (open ? '' : QUOTE)
}

function needsQuoting(path: string): boolean {
  for (const character of path) {
    if (TOKEN_DELIMITERS.has(character)) return true
  }
  return false
}

/** Where the run's one still-open quote begins, or null when every quote closed. */
function openQuoteStart(text: string): number | null {
  let start: number | null = null
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    // An escaped quote is a path character, not the end of the run, so the
    // character after an escape is never read as a delimiter here.
    if (character === ESCAPE) {
      index += 1
      continue
    }
    if (character !== QUOTE) continue
    start = start === null ? index : null
  }
  return start
}

/** Read a quoted run back, so the fragment is the path and not its escapes. */
function unescape(raw: string): string {
  let out = ''
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index] ?? ''
    if (character === ESCAPE && index + 1 < raw.length) {
      const next = raw[index + 1] ?? ''
      if (next === ESCAPE || next === QUOTE) {
        out += next
        index += 1
        continue
      }
    }
    out += character
  }
  return out
}

/** Whether an at-sign at this index opens a token rather than continuing a word. */
function isTokenStart(text: string, index: number): boolean {
  return index === 0 || TOKEN_DELIMITERS.has(text[index - 1] ?? '')
}

/** Drop the dot-slash habit a shell reader brings, which no path in the index carries. */
function withoutDotSlash(raw: string): string {
  return raw.startsWith('./') ? raw.slice(2) : raw
}

/** Bytes a terminal executes rather than draws. */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/

/**
 * Whether a listed path may become a suggestion.
 *
 * A suggestion is inserted into the prompt the agent reads, so a path that
 * climbs out of the workspace, or that carries bytes a terminal would act on,
 * is never offered: the menu is the one place the reader cannot see the bytes
 * for what they are.
 */
export function offerablePath(path: string): boolean {
  return path !== '' && !path.startsWith('/') && !path.split('/').includes('..') && !CONTROL_CHARACTERS.test(path)
}

/** What a token cannot carry without being split, as the editor's own trigger reads it. */
const WHITESPACE_CHARACTER = /\s/

/**
 * Whether a row may be offered at all.
 *
 * A directory is a place to keep typing, and the editor only asks for
 * suggestions while the typed token holds no whitespace: offering a directory
 * whose path has one would leave the reader stuck after the pick. Its files
 * are still offered on their own, each with a value that needs no narrowing.
 */
export function offerableCandidate(candidate: Candidate): boolean {
  if (!offerablePath(candidate.path)) return false
  return !candidate.isDirectory || !WHITESPACE_CHARACTER.test(candidate.path)
}

/**
 * The rows that best answer the fragment, best first.
 *
 * Only the paths are searched, the way fzf searches a path list, so a fragment
 * may match a segment anywhere in the tree. Ties fall to a directory over a
 * file — a directory is a place to keep typing, a file ends the search — then
 * to the shallower, shorter path, which is the one the reader is likelier to
 * mean.
 */
export function rankFiles(query: string, candidates: readonly Candidate[], limit: number): readonly Candidate[] {
  const needle = query.trim()
  if (needle === '') return topLevel(candidates, limit)
  const scored: { candidate: Candidate; score: number }[] = []
  for (const candidate of candidates) {
    const score = fuzzyScore(needle, candidate.path)
    if (score === undefined) continue
    scored.push({ candidate, score })
  }
  scored.sort((left, right) => compareScored(left, right))
  return scored.slice(0, limit).map(entry => entry.candidate)
}

interface Scored {
  readonly candidate: Candidate
  readonly score: number
}

function compareScored(left: Scored, right: Scored): number {
  if (left.score !== right.score) return right.score - left.score
  if (left.candidate.isDirectory !== right.candidate.isDirectory) return left.candidate.isDirectory ? -1 : 1
  const depth = depthOf(left.candidate.path) - depthOf(right.candidate.path)
  if (depth !== 0) return depth
  const length = left.candidate.path.length - right.candidate.path.length
  if (length !== 0) return length
  return left.candidate.path.localeCompare(right.candidate.path)
}

function depthOf(path: string): number {
  return path.split('/').length
}

/** The entries a bare at-sign offers: what sits directly in the workspace. */
function topLevel(candidates: readonly Candidate[], limit: number): readonly Candidate[] {
  return candidates
    .filter(candidate => !candidate.path.includes('/'))
    .sort((left, right) => {
      if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1
      return left.path.localeCompare(right.path)
    })
    .slice(0, limit)
}

/** One source of workspace rows: a git listing, or a walk when git cannot answer. */
export type FileLister = (cwd: string, signal: AbortSignal) => Promise<readonly Candidate[]>

/** What a caller may replace when it needs a different workspace or clock. */
export interface FileIndexOptions {
  readonly list?: FileLister
  readonly now?: () => number
  readonly ttlMs?: number
  readonly scanTimeoutMs?: number
  readonly resolve?: (path: string) => Promise<string>
  readonly proofTimeoutMs?: number
}

/**
 * The workspace rows, gathered once and reused for a short window.
 *
 * Gathered lazily rather than at mount, because most sessions never type an
 * at-sign, and held briefly rather than forever, because the agent writes
 * files into this very tree while the reader is looking at it.
 */
export interface FileIndex {
  candidates(signal: AbortSignal): Promise<readonly Candidate[]>
  /**
   * Whether a listed path still resolves to something this workspace holds.
   *
   * A listing is a snapshot, and what it described can be replaced between the
   * listing and the menu: a proof taken when a row is offered is the only one
   * that covers a link planted after the scan.
   */
  reachable(path: string, signal: AbortSignal): Promise<boolean>
}

/** How long a gathered listing is trusted before the tree is read again. */
const INDEX_TTL_MS = 1_000

/** How long git is given before the menu stops waiting for its answer. */
const GIT_TIMEOUT_MS = 3_000

/** How long one scan may run before the index abandons it, awaited or not. */
const SCAN_TIMEOUT_MS = 5_000

/** How long proving one row may hold the menu before that row is left out. */
const ROW_PROOF_TIMEOUT_MS = 500

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

async function canonicalOrUndefined(path: string): Promise<string | undefined> {
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

/** One shared scan: the work, and the deadline signal a waiter may leave on. */
interface Scan {
  readonly run: Promise<readonly Candidate[]>
  readonly signal: AbortSignal
}

/** A listing cache with a window, so a keystroke does not become a scan. */
export function createFileIndex(cwd: string, options: FileIndexOptions = {}): FileIndex {
  const list = options.list ?? listWorkspaceFiles
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? INDEX_TTL_MS
  const scanTimeoutMs = options.scanTimeoutMs ?? SCAN_TIMEOUT_MS
  const resolvePath = options.resolve ?? realpath
  const proofTimeoutMs = options.proofTimeoutMs ?? ROW_PROOF_TIMEOUT_MS
  let cached: readonly Candidate[] | undefined
  let cachedAt = 0
  let pending: Scan | undefined
  let root: Promise<string | undefined> | undefined

  const startScan = (): Scan => {
    // The scan is shared, so it cannot ride any one caller's signal: the first
    // reader to look away would otherwise cancel the listing every other reader
    // is still waiting on. It runs under its own bound and leaves its answer for
    // the readers that follow.
    const scan = new AbortController()
    const run = list(cwd, scan.signal)
      .then(found => {
        // An answer that arrives after the deadline is the one the waiting
        // readers were told to stop waiting for; keeping it would serve a
        // listing the scan had already given up on.
        if (!scan.signal.aborted) {
          cached = found
          cachedAt = now()
        }
        return found
      })
      .catch(() => [] as readonly Candidate[])
    const entry: Scan = { run, signal: scan.signal }
    pending = entry
    const timer = setTimeout(() => {
      scan.abort()
      // A caller arriving after the deadline starts fresh work instead of
      // joining a scan that outlived its bound.
      if (pending === entry) pending = undefined
    }, scanTimeoutMs)
    void run.finally(() => {
      clearTimeout(timer)
      // A settled scan is no longer pending even when its listing was refused
      // for arriving late; a fresh scan is the next caller's own business.
      if (pending === entry) pending = undefined
    })
    return entry
  }

  return {
    async candidates(signal: AbortSignal): Promise<readonly Candidate[]> {
      // A caller that has already looked away is answered from what the index
      // holds, without starting work it would not wait for.
      if (signal.aborted) return cached ?? []
      if (cached !== undefined && now() - cachedAt < ttlMs) return cached
      const entry = pending ?? startScan()
      // The deadline releases a waiter even when the work beneath it cannot be
      // interrupted, which is the only way a blocked filesystem call stops
      // holding the menu.
      const found = await untilAborted(entry.run, signal, entry.signal)
      return found ?? cached ?? []
    },
    async reachable(path: string, signal: AbortSignal): Promise<boolean> {
      if (signal.aborted) return false
      root ??= canonicalOrUndefined(cwd)
      // Both the root and the row are bound the same way: a filesystem that
      // stopped answering must not hold a menu open, and a proof that did not
      // arrive in time is a proof that never happened.
      const canonical = await withinBound(root, signal, proofTimeoutMs)
      // The caller may have looked away while the root was being proven, and row
      // work started behind its back would have nothing left to answer for it.
      if (canonical === undefined || signal.aborted) return false
      const target = await withinBound(resolvePath(join(cwd, path)), signal, proofTimeoutMs)
      if (target === undefined) return false
      const inside = relative(canonical, target)
      return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside)
    },
  }
}

/** Wait for one filesystem answer, but only while the caller is still waiting. */
function withinBound<T>(work: Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T | undefined> {
  if (signal.aborted) {
    // Work that was already started still has to be answered for, or a refusal
    // it reports would reach the process instead of this caller.
    void work.catch(() => undefined)
    return Promise.resolve(undefined)
  }
  return new Promise<T | undefined>(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (value: T | undefined): void => {
      if (timer !== undefined) clearTimeout(timer)
      signal.removeEventListener('abort', stop)
      resolve(value)
    }
    const stop = (): void => finish(undefined)
    timer = setTimeout(stop, timeoutMs)
    signal.addEventListener('abort', stop, { once: true })
    work.then(value => finish(value), () => finish(undefined))
  })
}

/** Wait for shared work, but leave as soon as any reason to stop waiting fires. */
function untilAborted<T>(work: Promise<T>, ...signals: readonly AbortSignal[]): Promise<T | undefined> {
  if (signals.some(signal => signal.aborted)) {
    void work.catch(() => undefined)
    return Promise.resolve(undefined)
  }
  return new Promise<T | undefined>((resolve, reject) => {
    const stopWaiting = (): void => {
      for (const signal of signals) signal.removeEventListener('abort', stopWaiting)
      resolve(undefined)
    }
    for (const signal of signals) signal.addEventListener('abort', stopWaiting, { once: true })
    work.then(
      value => {
        for (const signal of signals) signal.removeEventListener('abort', stopWaiting)
        resolve(value)
      },
      error => {
        for (const signal of signals) signal.removeEventListener('abort', stopWaiting)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}
