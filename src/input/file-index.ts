import { type Candidate } from './file-search.ts'
import { listWorkspaceFiles, canonicalOrUndefined } from './workspace-files.ts'
import { realpath } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'

/**
 * One file list per root, shared by everything that asks for it at once.
 *
 * Offers are cheap but proofs are not, so the cache, its lifetime, the shared
 * scan deadline, and the per-row reachability check live together apart from
 * both the ranking that decides what to offer and the walk that lists it.
 */

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

/** How long one scan may run before the index abandons it, awaited or not. */
const SCAN_TIMEOUT_MS = 5_000

/** How long proving one row may hold the menu before that row is left out. */
const ROW_PROOF_TIMEOUT_MS = 500

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
