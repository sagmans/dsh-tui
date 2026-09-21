import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'

/**
 * Global prompt history for the terminal surface.
 *
 * The file is deliberately project-agnostic: a reader who types the same prompt
 * in two checkouts wants it offered in both, so nothing here records a working
 * directory. It lives beside the reader's other harness preferences rather than
 * inside the profile, because a profile is replaced on install and history is
 * theirs to keep.
 */

/** Environment variable that overrides the harness home, matching the launcher. */
export const DSH_HOME_ENV = 'DSH_HOME'
/** Directory name of the default harness home under the OS home. */
export const DSH_HOME_DIR_NAME = '.dsh'
/** File name the history is stored under, inside the harness home. */
export const HISTORY_FILE_NAME = 'prompt-history.json'
/** Schema this build writes; a file that names another positive version is left alone. */
export const HISTORY_SCHEMA_VERSION = 1
/** Entries kept when the reader configures nothing. */
export const DEFAULT_MAX_ENTRIES = 2000
/** Largest cap a reader may ask for, so a typo cannot grow the file without bound. */
export const MAX_ENTRIES_LIMIT = 20_000

/** Only the reader can read or write the file. */
const PRIVATE_FILE_MODE = 0o600
/** A created home directory stays private; an existing one is never re-moded. */
const PRIVATE_DIR_MODE = 0o700

/** Why the store refuses to write, which is a reason the reader can act on. */
export type HistoryBlockReason = 'corrupt_history' | 'unsupported_schema' | 'unreadable_history'

/** One recorded prompt, newest first in the file. */
export interface PromptEntry {
  readonly text: string
  readonly updatedAt: string
  readonly useCount: number
}

/** The persisted document, versioned so a future shape can be recognized. */
export interface PromptHistoryFile {
  readonly version: number
  readonly updatedAt: string
  readonly entries: readonly PromptEntry[]
}

/** A file read reduced to what a caller can act on. */
export type ParsedHistoryFile =
  | { readonly kind: 'ready'; readonly file: PromptHistoryFile }
  | { readonly kind: 'blocked'; readonly reason: HistoryBlockReason }

/** The store the surface holds; mutations are fire-and-forget and serialized. */
export interface PromptHistory {
  /** Current entries, newest first; the array identity is stable per snapshot. */
  entries(): readonly PromptEntry[]
  /** Persist one submitted prompt; blank input is ignored. */
  record(text: string): void
  /** Remove every entry and report how many went. */
  clear(): Promise<number>
  /** Resolve once every queued mutation has settled; errors are reported, not thrown. */
  flush(): Promise<void>
  /** Absolute path of the file, for a status line and diagnostics. */
  path(): string
  /** Why writes are refused, or undefined while the store is healthy. */
  blockedReason(): HistoryBlockReason | undefined
}

/** Inputs the surface supplies; every one is a seam a test drives. */
export interface PromptHistoryOptions {
  /** Resolved harness home; defaults to $DSH_HOME or ~/.dsh. */
  readonly home?: string
  /** Read per mutation so a settings edit takes effect without a restart. */
  readonly cap: () => number
  readonly now?: () => Date
  readonly warn?: (message: string) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** Expand a tilde the way the launcher does, so both spell the home the same. */
function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve the harness home.
 *
 * Precedence is the launcher's own: $DSH_HOME, then ~/.dsh. A blank override is
 * treated as unset, because resolving to the working directory would scatter
 * private history into whatever tree the reader happened to start from.
 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[DSH_HOME_ENV]
  const chosen = configured !== undefined && configured.trim() !== ''
    ? expandHome(configured)
    : join(homedir(), DSH_HOME_DIR_NAME)
  return resolvePath(chosen)
}

/** Read one persisted document, refusing anything this build cannot safely rewrite. */
export function parseHistoryFile(text: string): ParsedHistoryFile {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { kind: 'blocked', reason: 'corrupt_history' }
  }
  if (!isRecord(raw) || !isPositiveInteger(raw.version)) return { kind: 'blocked', reason: 'corrupt_history' }
  // Any other positive version may be valid to newer code, so preserve it rather
  // than normalize it away and lose entries this build does not understand.
  if (raw.version !== HISTORY_SCHEMA_VERSION) return { kind: 'blocked', reason: 'unsupported_schema' }
  if (typeof raw.updatedAt !== 'string' || !Array.isArray(raw.entries)) {
    return { kind: 'blocked', reason: 'corrupt_history' }
  }
  const entries = normalizeEntries(raw.entries)
  if (entries === undefined) return { kind: 'blocked', reason: 'corrupt_history' }
  return { kind: 'ready', file: { version: HISTORY_SCHEMA_VERSION, updatedAt: raw.updatedAt, entries } }
}

function normalizeEntries(rawEntries: readonly unknown[]): PromptEntry[] | undefined {
  const entries: PromptEntry[] = []
  for (const raw of rawEntries) {
    const normalized = normalizeEntry(raw)
    if (normalized === undefined) return undefined
    entries.push(normalized)
  }
  return entries
}

function normalizeEntry(raw: unknown): PromptEntry | undefined {
  if (!isRecord(raw)) return undefined
  if (typeof raw.text !== 'string' || raw.text.trim() === '') return undefined
  if (typeof raw.updatedAt !== 'string') return undefined
  if (!isPositiveInteger(raw.useCount)) return undefined
  return { text: raw.text, updatedAt: raw.updatedAt, useCount: raw.useCount }
}

/**
 * Put one prompt at the front, replacing an exact duplicate.
 *
 * A duplicate is moved rather than copied so a repeated prompt resurfaces as the
 * newest suggestion without ever appearing twice in the list.
 */
export function upsertEntry(
  entries: readonly PromptEntry[],
  text: string,
  now: string,
  maxEntries: number,
): PromptEntry[] {
  const existing = entries.find(entry => entry.text === text)
  const next: PromptEntry = existing === undefined
    ? { text, updatedAt: now, useCount: 1 }
    : { text, updatedAt: laterTimestamp(existing.updatedAt, now), useCount: existing.useCount + 1 }
  return [next, ...entries.filter(entry => entry.text !== text)].slice(0, Math.max(0, maxEntries))
}

function laterTimestamp(left: string, right: string): string {
  return left >= right ? left : right
}

/** Build the store the surface records into and completes from. */
export function createPromptHistory(options: PromptHistoryOptions): PromptHistory {
  const now = options.now ?? (() => new Date())
  const warn = options.warn ?? (() => {})
  const filePath = join(options.home ?? resolveDshHome(), HISTORY_FILE_NAME)
  let entries: readonly PromptEntry[] = []
  let blocked: HistoryBlockReason | undefined
  const warned = new Set<string>()

  const warnOnce = (key: string, message: string): void => {
    if (warned.has(key)) return
    warned.add(key)
    warn(message)
  }

  // Every mutation rides one chain so a clear can never be overtaken by a record
  // that started earlier; without it a slow initial read could resurrect an
  // entry the reader just removed.
  let chain: Promise<void> = load()

  async function load(): Promise<void> {
    let text: string
    try {
      text = await readFile(filePath, 'utf8')
    } catch (error) {
      if (isMissingFile(error)) return
      blocked = 'unreadable_history'
      warnOnce('load:unreadable', 'prompt history is unreadable; writes are disabled until it can be read')
      return
    }
    const parsed = parseHistoryFile(text)
    if (parsed.kind === 'blocked') {
      blocked = parsed.reason
      const shape = parsed.reason === 'unsupported_schema' ? 'a newer format' : 'corrupt'
      warnOnce('load:' + parsed.reason, 'prompt history is ' + shape + '; writes are disabled and the file is left untouched')
      return
    }
    entries = parsed.file.entries
  }

  function enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    const run = chain.then(operation)
    chain = run.then(() => {}, () => {})
    return run
  }

  async function write(): Promise<void> {
    const file: PromptHistoryFile = { version: HISTORY_SCHEMA_VERSION, updatedAt: now().toISOString(), entries }
    const tempPath = filePath + '.' + process.pid + '.' + Date.now() + '.tmp'
    await mkdir(dirname(filePath), { recursive: true, mode: PRIVATE_DIR_MODE })
    try {
      await writeFile(tempPath, JSON.stringify(file, null, 2) + '\n', { encoding: 'utf8', mode: PRIVATE_FILE_MODE })
      await chmod(tempPath, PRIVATE_FILE_MODE)
      await rename(tempPath, filePath)
    } catch (error) {
      await rm(tempPath, { force: true })
      throw error
    }
  }

  return {
    entries: () => entries,
    path: () => filePath,
    blockedReason: () => blocked,
    record(text: string): void {
      if (text.trim() === '') return
      void enqueue(async () => {
        if (blocked !== undefined) return
        entries = upsertEntry(entries, text, now().toISOString(), options.cap())
        await write()
      }).catch(() => {
        warnOnce('write', 'prompt history could not be written; this session keeps it in memory only')
      })
    },
    clear(): Promise<number> {
      return enqueue(async () => {
        if (blocked !== undefined) return 0
        const removed = entries.length
        entries = []
        await write()
        return removed
      })
    },
    flush: () => chain,
  }
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}
