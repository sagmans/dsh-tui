import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
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
  // delimiter scan: otherwise the space inside @"my file" would look like the
  // end of the token.
  const quoteStart = openQuoteStart(text)
  if (quoteStart !== null && quoteStart > 0 && text[quoteStart - 1] === '@' && isTokenStart(text, quoteStart - 1)) {
    const raw = text.slice(quoteStart + 1)
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

/** Where the run's one still-open quote begins, or null when every quote closed. */
function openQuoteStart(text: string): number | null {
  let start: number | null = null
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '"') continue
    start = start === null ? index : null
  }
  return start
}

/** Whether an at-sign at this index opens a token rather than continuing a word. */
function isTokenStart(text: string, index: number): boolean {
  return index === 0 || TOKEN_DELIMITERS.has(text[index - 1] ?? '')
}

/** Drop the dot-slash habit a shell reader brings, which no path in the index carries. */
function withoutDotSlash(raw: string): string {
  return raw.startsWith('./') ? raw.slice(2) : raw
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
}

/** How long a gathered listing is trusted before the tree is read again. */
const INDEX_TTL_MS = 1_000

/** How long git is given before the menu stops waiting for its answer. */
const GIT_TIMEOUT_MS = 3_000

/**
 * The git listing that answers for a workspace.
 *
 * Tracked files and untracked ones that git would add, with ignored paths left
 * out: that is the set the agent itself works on, so a suggestion can never
 * name a build artifact or a secret the repository deliberately ignores.
 */
const GIT_LIST_ARGUMENTS = ['ls-files', '-z', '--cached', '--others', '--exclude-standard']

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
  const fromGit = await gitFiles(cwd, signal)
  if (signal.aborted) return []
  if (fromGit !== undefined) return fromGit
  return await walkFiles(cwd, signal)
}

/** Git's answer, or undefined when git is absent, refused, or too slow. */
function gitFiles(cwd: string, signal: AbortSignal): Promise<readonly Candidate[] | undefined> {
  return new Promise(resolve => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (value: readonly Candidate[] | undefined): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const child = spawn('git', GIT_LIST_ARGUMENTS, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
    const onAbort = (): void => {
      child.kill('SIGKILL')
      finish(undefined)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(undefined)
    }, GIT_TIMEOUT_MS)
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.on('error', () => finish(undefined))
    child.on('close', code => {
      if (code !== 0) {
        finish(undefined)
        return
      }
      finish(candidatesFrom(stdout.split('\0')))
    })
  })
}

/**
 * Turn git's file list into rows, deriving the directories it implies.
 *
 * Git lists files only, but a reader typing a path prefix wants to open a
 * directory as readily as a file. Paths that would climb out of the workspace
 * are dropped: a suggestion is inserted into a prompt the agent acts on, so it
 * must never name something outside the tree the reader is working in.
 */
function candidatesFrom(paths: readonly string[]): readonly Candidate[] {
  const files: Candidate[] = []
  const directories = new Set<string>()
  for (const path of paths) {
    if (path === '' || path.startsWith('/') || path.split('/').includes('..')) continue
    files.push({ path, isDirectory: false })
    for (let at = path.indexOf('/'); at >= 0; at = path.indexOf('/', at + 1)) {
      directories.add(path.slice(0, at))
    }
  }
  const rows = [...directories].map(path => ({ path, isDirectory: true }))
  return [...rows, ...files].sort((left, right) => left.path.localeCompare(right.path))
}

/** Walk a tree git does not own, breadth first, stopping at the caps above. */
export async function walkFiles(cwd: string, signal: AbortSignal): Promise<readonly Candidate[]> {
  const found: Candidate[] = []
  const queue: string[] = ['']
  while (queue.length > 0) {
    if (signal.aborted) return []
    const relative = queue.shift() ?? ''
    let entries
    try {
      entries = await readdir(relative === '' ? cwd : join(cwd, relative), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (found.length >= MAX_WALK_ENTRIES) return found
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`
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

/** A listing cache with a window, so a keystroke does not become a scan. */
export function createFileIndex(cwd: string, options: FileIndexOptions = {}): FileIndex {
  const list = options.list ?? listWorkspaceFiles
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? INDEX_TTL_MS
  let cached: readonly Candidate[] | undefined
  let cachedAt = 0
  let pending: Promise<readonly Candidate[]> | undefined

  return {
    async candidates(signal: AbortSignal): Promise<readonly Candidate[]> {
      if (cached !== undefined && now() - cachedAt < ttlMs) return cached
      if (pending === undefined) {
        // One scan serves every reader typing at the same moment, and an
        // interrupted one is never cached: half a tree would look like the
        // whole answer until the window passed.
        pending = list(cwd, signal)
          .then(found => {
            if (!signal.aborted) {
              cached = found
              cachedAt = now()
            }
            return found
          })
          .finally(() => {
            pending = undefined
          })
      }
      const found = await pending
      return signal.aborted ? cached ?? [] : found
    },
  }
}
