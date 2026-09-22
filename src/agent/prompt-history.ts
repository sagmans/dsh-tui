import { randomUUID } from 'node:crypto'
import { chmod, link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { displayText } from '../text.ts'

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
/** Suffix of the file that serializes mutations across sessions. */
const LOCK_SUFFIX = '.lock'
/** Suffix of the lock that guards replacing a lock whose holder stopped. */
const LOCK_RECLAIM_SUFFIX = '.reclaim'
/** Suffix of the file a lock is staged in before it is published. */
const LOCK_TEMP_SUFFIX = '.tmp'
/** How long a mutation waits for another session's lock before giving up. */
const LOCK_WAIT_MS = 2_000
/** Delay between lock attempts, so a short hold is not a spin. */
const LOCK_RETRY_MS = 20
/** Separates the fields a lock file names its holder with. */
const LOCK_FIELD_SEPARATOR = ' '

/** Why the store refuses to write, which is a reason the reader can act on. */
export type HistoryBlockReason = 'corrupt_history' | 'unsupported_schema' | 'unreadable_history'

/** One phrase per refusal, so a notice reads the same wherever it is raised. */
const BLOCK_DESCRIPTIONS: Record<HistoryBlockReason, string> = {
  corrupt_history: 'corrupt',
  unsupported_schema: 'a newer format',
  unreadable_history: 'unreadable',
}

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
  /** Lock wait a test can shorten; defaults to LOCK_WAIT_MS. */
  readonly lockWaitMs?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isAlreadyExists(error: unknown): boolean {
  return isRecord(error) && error.code === 'EEXIST'
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** The holder a lock file names, so a session can tell whom it would displace. */
interface LockOwner {
  readonly pid: number
  readonly token: string
}

function serializeOwner(owner: LockOwner): string {
  return owner.pid + LOCK_FIELD_SEPARATOR + owner.token + '\n'
}

function parseOwner(text: string): LockOwner | undefined {
  const [pid, token] = text.trim().split(LOCK_FIELD_SEPARATOR)
  const value = Number(pid)
  if (!isPositiveInteger(value) || token === undefined || token === '') return undefined
  return { pid: value, token }
}

/** Whether the recorded holder can still run; only ESRCH proves that it cannot. */
function isOwnerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !isRecord(error) || error.code !== 'ESRCH'
  }
}

/**
 * Take the lock that serializes mutations across sessions.
 *
 * A second session that read the same entries before this one wrote would
 * otherwise replace the file with its own view and lose the first session's
 * prompts. The lock names its holder, so a dead session can be displaced while
 * a running one is waited for, and a holder that never lets go costs one
 * mutation rather than the whole file.
 */
async function acquireLock(lockPath: string, waitMs: number): Promise<LockOwner> {
  const deadline = Date.now() + waitMs
  const owner: LockOwner = { pid: process.pid, token: randomUUID() }
  for (;;) {
    const contents = await readFile(lockPath, 'utf8').catch(() => undefined)
    if (contents !== undefined) {
      const holder = parseOwner(contents)
      if (holder !== undefined && isOwnerAlive(holder.pid)) {
        if (Date.now() >= deadline) throw new Error('another session is writing the prompt history')
        await delay(LOCK_RETRY_MS)
        continue
      }
      await reclaimLock(lockPath, contents, Math.max(1, deadline - Date.now()))
      continue
    }
    if (await publishLock(lockPath, owner)) return owner
  }
}

/** Publish a lock naming `owner`; false when another holder got there first. */
async function publishLock(lockPath: string, owner: LockOwner): Promise<boolean> {
  // The holder is written before the lock path exists, so a contender can never
  // read a half-published lock and displace a live session.
  const staged = lockPath + '.' + owner.token + LOCK_TEMP_SUFFIX
  await writeFile(staged, serializeOwner(owner), { encoding: 'utf8', mode: PRIVATE_FILE_MODE })
  try {
    await link(staged, lockPath)
    return true
  } catch (error) {
    if (!isAlreadyExists(error)) throw error
    return false
  } finally {
    await rm(staged, { force: true }).catch(() => {})
  }
}

/**
 * Replace a lock whose holder cannot run, under a lock of its own.
 *
 * Two sessions that both judge the same lock dead would otherwise each remove
 * it, and one could remove the lock the other had just published, admitting two
 * writers. Displacing a stopped reclaimer would need a third lock, so that case
 * refuses instead: a wrong guess here means concurrent writers.
 */
async function reclaimLock(lockPath: string, deadContents: string, waitMs: number): Promise<void> {
  const reclaimPath = lockPath + LOCK_RECLAIM_SUFFIX
  const owner: LockOwner = { pid: process.pid, token: randomUUID() }
  const deadline = Date.now() + waitMs
  for (;;) {
    const contents = await readFile(reclaimPath, 'utf8').catch(() => undefined)
    if (contents === undefined) {
      if (await publishLock(reclaimPath, owner)) break
      continue
    }
    const holder = parseOwner(contents)
    if (holder !== undefined && isOwnerAlive(holder.pid)) {
      if (Date.now() >= deadline) throw new Error('another session is reclaiming the prompt history lock')
      await delay(LOCK_RETRY_MS)
      continue
    }
    throw new Error('prompt history lock at ' + reclaimPath + ' names a session that stopped; remove it to continue')
  }
  try {
    // No other reclaimer runs now, and a path cannot be published over, so the
    // dead lock is still the one this session judged.
    const current = await readFile(lockPath, 'utf8').catch(() => undefined)
    if (current === deadContents) await rm(lockPath, { force: true })
  } finally {
    await releaseLock(reclaimPath, owner)
  }
}

/** Give the lock back only while it still names this holder, never a successor. */
async function releaseLock(lockPath: string, owner: LockOwner): Promise<void> {
  const contents = await readFile(lockPath, 'utf8').catch(() => undefined)
  if (contents !== serializeOwner(owner)) return
  await rm(lockPath, { force: true }).catch(() => {})
}

/** Run one read-modify-replace under the lock, so nothing lands between them. */
async function withLock<Result>(lockPath: string, waitMs: number, operation: () => Promise<Result>): Promise<Result> {
  await mkdir(dirname(lockPath), { recursive: true, mode: PRIVATE_DIR_MODE })
  const owner = await acquireLock(lockPath, waitMs)
  try {
    return await operation()
  } finally {
    await releaseLock(lockPath, owner)
  }
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
  // A prompt reaches the ghost, the picker, and the bar again, and the terminal
  // executes what it is given: the stored text is the one boundary every later
  // consumer crosses, so a control sequence is spelled out before it is kept. A
  // tab is kept as a tab, because the bar it is restored into has stops of its
  // own and expanding it here would change what the reader typed.
  return { text: displayText(raw.text, { tab: 'keep' }), updatedAt: raw.updatedAt, useCount: raw.useCount }
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
  const lockPath = filePath + LOCK_SUFFIX
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
  // entry the reader just removed. Each mutation also re-reads the file, because
  // a second session may have written since this one loaded and its prompts must
  // be folded in rather than overwritten.
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
      warnOnce('load:' + parsed.reason, 'prompt history is ' + BLOCK_DESCRIPTIONS[parsed.reason] + '; writes are disabled and the file is left untouched')
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
      const prompt = displayText(text, { tab: 'keep' })
      void enqueue(() => withLock(lockPath, options.lockWaitMs ?? LOCK_WAIT_MS, async () => {
        await load()
        if (blocked !== undefined) return
        entries = upsertEntry(entries, prompt, now().toISOString(), options.cap())
        await write()
      })).catch((error: unknown) => {
        // The reason can name the lock file that must be removed by hand, so it
        // belongs in the notice rather than behind a single opaque sentence.
        const reason = error instanceof Error && error.message !== '' ? ': ' + error.message : ''
        warnOnce('write' + reason, 'prompt history could not be written; this session keeps it in memory only' + reason)
      })
    },
    clear(): Promise<number> {
      return enqueue(() => withLock(lockPath, options.lockWaitMs ?? LOCK_WAIT_MS, async () => {
        await load()
        // A file that changed under the reader cannot be cleared safely, and
        // reporting a successful clear of nothing would be worse than refusing.
        if (blocked !== undefined) throw new Error('the file is ' + BLOCK_DESCRIPTIONS[blocked])
        const removed = entries.length
        const previous = entries
        entries = []
        try {
          await write()
        } catch (error) {
          // The file still holds the prompts, so memory follows it back rather
          // than reporting a clear the reader would meet again on next start.
          entries = previous
          throw error
        }
        return removed
      }))
    },
    flush: () => chain,
  }
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}
