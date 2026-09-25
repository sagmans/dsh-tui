// User-facing prompt-stash operations, independent of the terminal surface.
//
// Every command funnels through one serial queue, so a chord and a typed command
// can never interleave a read-modify-write on the same bank. The surface is
// reached through a small host seam, which keeps these operations testable
// without a terminal and keeps the editor's own text rules — an expanded paste
// and an empty bar — in exactly one place.

import path from 'node:path'
import { FileTooLargeError } from './stash/private-fs.ts'
import { StashCommittedError } from './stash/lock.ts'
import { DEFAULT_STASH_SCOPE, resolveStashPaths, stashBaseDir, type StashScope } from './stash/paths.ts'
import type { ResolvedEntry } from './stash/schema.ts'
import {
  loadStashStore,
  UnsupportedStashSchemaError,
  type StashStore,
  type StashWriter,
} from './stash/store.ts'

const EDITOR_BLOCKED_MESSAGE = 'clear or stash the current draft before applying or popping'
const EDITOR_BUSY_MESSAGE = 'the prompt bar is answering a question; finish or cancel it first'
const NOTHING_TO_STASH_MESSAGE = 'nothing to stash'
const NO_DRAFTS_MESSAGE = 'no stashed drafts'
const CORRUPT_RECOVERY_MESSAGE = 'corrupt stash data was quarantined to'
const CORRUPT_RECOVERY_UNSYNCED_MESSAGE = ' (its directory could not be synced, so the copy may not survive a crash)'
const SESSION_CHANGED_MESSAGE = 'the session changed; the stash stayed with the session it belonged to'
const PATH_SESSION_CHANGED_MESSAGE = 'the session changed; the stash stayed with the directory it belonged to'

const stashedMessage = (index: number): string => `Stashed [${index}]`
const appliedMessage = (index: number): string => `Applied [${index}]`
const poppedMessage = (index: number): string => `Popped [${index}]`
const droppedMessage = (index: number): string => `Dropped [${index}]`
const clearedMessage = (count: number): string => `Cleared ${count} draft${count === 1 ? '' : 's'}`
const selectorMissingMessage = (selector: string): string => `no stash matching "${selector}"`
const committedMessage = (error: StashCommittedError, done: string): string =>
  error.releaseFailure === undefined
    ? `${done}, but the ${error.failure.phase} step failed`
    : `${done}, but the ${error.failure.phase} and ${error.releaseFailure.phase} steps failed`
const removalFailedMessage = (error: unknown, done: string): string =>
  `${done}, but removing the entry failed: ${error instanceof Error ? error.message : 'unknown error'}`

/**
 * Everything the stash needs from the surface.
 *
 * The surface owns the editor and the picker, so the stash asks for text and
 * hands back text; it never reaches into a component of its own. `render` is
 * called after every state change so the status count follows the bank, and
 * `editorIsAvailable` is what tells a stash that the bar is the reader's rather
 * than a question's: writing a draft into an answer would submit it as one.
 */
export interface StashHost {
  /** The draft as written, with a pasted block expanded back to its text. */
  getEditorText(): string
  setEditorText(text: string): void
  /** Whether the prompt bar currently belongs to the reader. */
  editorIsAvailable(): boolean
  notice(message: string): void
  /** Ask the reader which entry to take, by id; undefined when they leave. */
  pick(entries: readonly ResolvedEntry[], bankLabel: string): Promise<string | undefined>
  /** Ask the reader to confirm clearing `count` drafts. */
  confirm(count: number): Promise<boolean>
  render(): void
}

export interface PromptStashOptions {
  /**
   * The session the surface is on now.
   *
   * A command reads this once, when the reader asks for it, and holds that
   * session for the whole operation: the surface can move on while a command
   * waits in the queue, and a command that re-read the session afterwards would
   * drop or clear the drafts of the session it moved to. `open` is the one
   * caller that re-reads it, because following the surface is its whole job.
   */
  readonly sessionId: () => string
  /** Share a bank by absolute directory, or keep one bank per session. */
  readonly scope?: StashScope | undefined
  /** Override the working directory captured at construction; tests avoid changing process cwd. */
  readonly directory?: string | undefined
  /** Override the storage root; tests keep it inside a scratch directory. */
  readonly baseDir?: string | undefined
  readonly now?: (() => number) | undefined
  readonly write?: StashWriter | undefined
}

function describeFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : 'unknown error'
  return error instanceof UnsupportedStashSchemaError || error instanceof FileTooLargeError
    ? `stash unavailable: ${detail}`
    : `stash failed: ${detail}`
}

export class PromptStash {
  private readonly baseDir: string
  private readonly bankScope: StashScope
  private readonly directory: string
  private readonly now: (() => number) | undefined
  private readonly write: StashWriter | undefined
  private store: StashStore | undefined
  /** Bank identity prevents a session switch from showing another bank's count. */
  private scope: string | undefined
  private count = 0
  /** The queue a second command waits behind, so writes never interleave. */
  private tail: Promise<void> = Promise.resolve()

  constructor(
    private readonly host: StashHost,
    private readonly options: PromptStashOptions,
  ) {
    this.baseDir = options.baseDir ?? stashBaseDir()
    this.bankScope = options.scope ?? DEFAULT_STASH_SCOPE
    this.directory = path.resolve(options.directory ?? process.cwd())
    this.now = options.now
    this.write = options.write
  }

  /** How many drafts the active bank holds, as last read. */
  get entryCount(): number {
    return this.count
  }

  /**
   * Read the bank in force, so the status count follows either selected scope.
   * A read creates nothing on disk, so a bank without drafts leaves no file.
   */
  open(): Promise<void> {
    return this.enqueue(async () => {
      try {
        await (await this.ensure(this.options.sessionId())).refresh()
      } catch (error) {
        this.host.notice(describeFailure(error))
      }
      this.sync()
    })
  }

  /**
   * Persist the draft the reader is looking at, or the one named on the command
   * line.
   *
   * An argument is written into the editor before the write is attempted —
   * before the bank is even opened — because the command line it came from is
   * already gone: a refused write has to leave the draft where the reader can
   * retry it instead of losing the only copy. A command that names nothing — the
   * chord, or a bare `/stash` — parks whatever the bar is holding.
   */
  stashEditor(typed?: string): Promise<void> {
    const sessionId = this.options.sessionId()
    const named = typed !== undefined && typed.trim() !== ''
    // The draft goes back into the bar before anything can fail, including
    // opening the bank: the command line it was typed on is already gone, so
    // this is the only copy until a write lands.
    const available = this.host.editorIsAvailable()
    if (named && available) this.host.setEditorText(typed)
    // The bar is read now, not when the queue reaches this command: a session
    // switch in between would otherwise park the next session's draft in this
    // bank and clear it from the bar the reader is typing in.
    const captured = available ? (named ? (typed as string) : this.host.getEditorText()) : undefined
    return this.run(sessionId, async store => {
      if (captured === undefined) {
        this.host.notice(EDITOR_BUSY_MESSAGE)
        return
      }
      const text = captured
      if (text.trim() === '') {
        this.host.notice(NOTHING_TO_STASH_MESSAGE)
        return
      }
      let resolved: ResolvedEntry
      let warning: string | undefined
      try {
        resolved = await store.add({ text })
      } catch (error) {
        if (!(error instanceof StashCommittedError)) throw error
        // The draft is on disk; only the step after the write failed. Reporting
        // a failure here would invite a retry that stashes the same draft twice.
        resolved = error.result as ResolvedEntry
        warning = committedMessage(error, stashedMessage(resolved.index))
      }
      // Only clear what was actually persisted, and only while the bar is still
      // the reader's and still this session's: a question can borrow the bar
      // during the write, and a session switch moves the whole surface on.
      const current = this.isCurrentSession(sessionId)
      if (current && this.host.editorIsAvailable() && this.host.getEditorText() === text) this.host.setEditorText('')
      this.host.notice(current ? (warning ?? stashedMessage(resolved.index)) : this.sessionChangedMessage())
    })
  }

  /** Put a draft in an empty editor without removing it. */
  apply(selector: string | undefined): Promise<void> {
    const sessionId = this.options.sessionId()
    return this.run(sessionId, async store => {
      await store.refresh()
      if (this.abandonIfMoved(sessionId)) return
      if (!this.editorIsReady()) return
      const resolved = store.find(selector)
      if (resolved === undefined) {
        this.host.notice(this.missingMessage(selector))
        return
      }
      this.host.setEditorText(resolved.entry.text)
      this.host.notice(appliedMessage(resolved.index))
    })
  }

  /** Put a draft in an empty editor and remove it from the bank. */
  pop(selector: string | undefined): Promise<void> {
    const sessionId = this.options.sessionId()
    return this.run(sessionId, async store => {
      // Re-read before resolving so "newest" is newest on disk, not newest as of
      // the last command; the removal re-reads again under the lock.
      await store.refresh()
      await this.popFrom(store, sessionId, selector)
    })
  }

  /** Open the list and pop whatever the reader takes. */
  list(sessionLabel: string): Promise<void> {
    const sessionId = this.options.sessionId()
    return this.run(sessionId, async store => {
      await store.refresh()
      if (this.abandonIfMoved(sessionId)) return
      if (store.entryCount === 0) {
        this.host.notice(NO_DRAFTS_MESSAGE)
        return
      }
      // The list is handed each entry with the index the bank gives it, so the
      // row a reader picks and the selector they could have typed agree.
      const rows = store.entries.map((entry, index) => ({ entry, index }))
      const picked = await this.host.pick(rows, this.bankScope === 'path' ? this.directory : sessionLabel)
      if (picked === undefined) return
      await this.popFrom(store, sessionId, picked)
    })
  }

  /** Delete one draft without using it. */
  drop(selector: string | undefined): Promise<void> {
    const sessionId = this.options.sessionId()
    return this.run(sessionId, async store => {
      let resolved: ResolvedEntry | undefined
      let warning: string | undefined
      try {
        resolved = await store.drop(selector)
      } catch (error) {
        if (!(error instanceof StashCommittedError)) throw error
        resolved = error.result as ResolvedEntry | undefined
        if (resolved === undefined) return
        warning = committedMessage(error, droppedMessage(resolved.index))
      }
      if (resolved === undefined) {
        this.host.notice(this.missingMessage(selector))
        return
      }
      this.host.notice(warning ?? droppedMessage(resolved.index))
    })
  }

  /** Confirm, then delete every draft the confirmation named. */
  clear(): Promise<void> {
    const sessionId = this.options.sessionId()
    return this.run(sessionId, async store => {
      await store.refresh()
      if (this.abandonIfMoved(sessionId)) return
      const count = store.entryCount
      if (count === 0) {
        this.host.notice(NO_DRAFTS_MESSAGE)
        return
      }
      // The ids the reader was shown, not the ids on disk afterwards: another
      // surface can stash while the dialog is open, and those drafts were never
      // part of what this confirmation agreed to delete.
      const confirmedIds = store.entries.map(entry => entry.id)
      if (!(await this.host.confirm(confirmedIds.length))) return
      let removed = confirmedIds.length
      let warning: string | undefined
      try {
        removed = await store.clear(confirmedIds)
      } catch (error) {
        if (!(error instanceof StashCommittedError)) throw error
        removed = error.result as number
        warning = committedMessage(error, clearedMessage(removed))
      }
      this.host.notice(warning ?? clearedMessage(removed))
    })
  }

  /**
   * Put one entry in an empty editor, then remove it.
   *
   * The editor is filled before the entry is removed, so a crash between the two
   * leaves the draft in the bank rather than only in a terminal that is gone.
   */
  private async popFrom(store: StashStore, sessionId: string, selector: string | undefined): Promise<void> {
    if (this.abandonIfMoved(sessionId)) return
    if (!this.editorIsReady()) return
    const resolved = store.find(selector)
    if (resolved === undefined) {
      this.host.notice(this.missingMessage(selector))
      return
    }
    this.host.setEditorText(resolved.entry.text)
    try {
      const removed = await store.removeById(resolved.entry.id)
      this.host.notice(poppedMessage(removed?.index ?? resolved.index))
    } catch (error) {
      if (error instanceof StashCommittedError) {
        this.host.notice(committedMessage(error, poppedMessage(resolved.index)))
        return
      }
      this.host.notice(removalFailedMessage(error, poppedMessage(resolved.index)))
    }
  }

  private editorIsReady(): boolean {
    if (!this.editorIsAvailable()) return false
    if (this.host.getEditorText().trim() === '') return true
    this.host.notice(EDITOR_BLOCKED_MESSAGE)
    return false
  }

  /**
   * Whether the bar is the reader's to write in.
   *
   * A question borrows the bar and empties it, so an empty check alone would
   * let a pop write the draft into an answer, and the draft's only other copy is
   * deleted right afterwards.
   */
  private editorIsAvailable(): boolean {
    if (this.host.editorIsAvailable()) return true
    this.host.notice(EDITOR_BUSY_MESSAGE)
    return false
  }

  private missingMessage(selector: string | undefined): string {
    const trimmed = selector?.trim()
    return trimmed === undefined || trimmed === ''
      ? NO_DRAFTS_MESSAGE
      : selectorMissingMessage(trimmed)
  }

  /**
   * The store of one bank, loaded on first use.
   *
   * Capture the session at submission so a queued command never retargets
   * its bank after the surface moves to another session.
   */
  private async ensure(sessionId: string): Promise<StashStore> {
    const bankId = this.bankId(sessionId)
    if (this.store !== undefined && this.scope === bankId) return this.store
    const owner = this.bankScope === 'path' ? this.directory : sessionId
    const store = await loadStashStore(resolveStashPaths(owner, this.baseDir, this.bankScope), this.now, this.write)
    this.store = store
    this.scope = bankId
    return store
  }

  private sessionChangedMessage(): string {
    return this.bankScope === 'path' ? PATH_SESSION_CHANGED_MESSAGE : SESSION_CHANGED_MESSAGE
  }

  private bankId(sessionId: string): string {
    return `${this.bankScope}:${this.bankScope === 'path' ? this.directory : sessionId}`
  }

  private run(sessionId: string, operation: (store: StashStore) => Promise<void>): Promise<void> {
    return this.enqueue(async () => {
      try {
        await operation(await this.ensure(sessionId))
      } catch (error) {
        this.host.notice(describeFailure(error))
      } finally {
        this.sync()
      }
    })
  }

  /** Whether the surface still shows the session a command was issued in. */
  private isCurrentSession(sessionId: string): boolean {
    return this.options.sessionId() === sessionId
  }

  /**
   * Stop a command whose session left the screen before the bar could be reached.
   *
   * The bank half has already run for the session that asked for it; writing its
   * draft into whatever bar is on screen now would hand it to the wrong reader.
   */
  private abandonIfMoved(sessionId: string): boolean {
    if (this.isCurrentSession(sessionId)) return false
    this.host.notice(this.sessionChangedMessage())
    return true
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const run = this.tail.then(operation, operation)
    this.tail = run.catch(() => undefined)
    return run
  }

  /** Publish the bank's size and any quarantine the last read produced. */
  private sync(): void {
    if (this.store !== undefined) {
      // A store read for a bank the surface has left must not set its count.
      this.count = this.scope === this.bankId(this.options.sessionId()) ? this.store.entryCount : 0
      const quarantine = this.store.takeQuarantine()
      if (quarantine !== undefined) {
        const durability = quarantine.syncFailed ? CORRUPT_RECOVERY_UNSYNCED_MESSAGE : ''
        this.host.notice(`${CORRUPT_RECOVERY_MESSAGE} ${quarantine.path}${durability}`)
      }
    }
    this.host.render()
  }
}
