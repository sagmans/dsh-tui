// User-facing prompt-stash operations, independent of the terminal surface.
//
// Every command funnels through one serial queue, so a chord and a typed command
// can never interleave a read-modify-write on the same bank. The surface is
// reached through a small host seam, which keeps these operations testable
// without a terminal and keeps the editor's own text rules — an expanded paste
// and an empty bar — in exactly one place.

import { FileTooLargeError } from './stash/private-fs.ts'
import { StashCommittedError } from './stash/lock.ts'
import { resolveStashPaths, stashBaseDir, type StashPaths } from './stash/paths.ts'
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
  pick(entries: readonly ResolvedEntry[], cwdLabel: string): Promise<string | undefined>
  /** Ask the reader to confirm clearing `count` drafts. */
  confirm(count: number): Promise<boolean>
  render(): void
}

export interface PromptStashOptions {
  readonly cwd: string
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
  private readonly paths: StashPaths
  private readonly now: (() => number) | undefined
  private readonly write: StashWriter | undefined
  private store: StashStore | undefined
  private count = 0
  /** The queue a second command waits behind, so writes never interleave. */
  private tail: Promise<void> = Promise.resolve()

  constructor(
    private readonly host: StashHost,
    private readonly options: PromptStashOptions,
  ) {
    this.paths = resolveStashPaths(options.cwd, options.baseDir ?? stashBaseDir())
    this.now = options.now
    this.write = options.write
  }

  /** How many drafts this directory holds, as last read. */
  get entryCount(): number {
    return this.count
  }

  /** Load the bank once at startup so the status count is real before a command. */
  async open(): Promise<void> {
    try {
      await this.ensure()
    } catch (error) {
      this.host.notice(describeFailure(error))
    }
    this.sync()
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
    const named = typed !== undefined && typed.trim() !== ''
    // The draft goes back into the bar before anything can fail, including
    // opening the bank: the command line it was typed on is already gone, so
    // this is the only copy until a write lands.
    if (named && this.host.editorIsAvailable()) this.host.setEditorText(typed)
    return this.run(async store => {
      if (!this.editorIsAvailable()) return
      const text = named ? (typed as string) : this.host.getEditorText()
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
      // Only clear what was actually persisted: a draft edited while the write
      // ran belongs to the reader, not to the bank.
      if (this.host.getEditorText() === text) this.host.setEditorText('')
      this.host.notice(warning ?? stashedMessage(resolved.index))
    })
  }

  /** Put a draft in an empty editor without removing it. */
  apply(selector: string | undefined): Promise<void> {
    return this.run(async store => {
      await store.refresh()
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
    return this.run(async store => {
      // Re-read before resolving so "newest" is newest on disk, not newest as of
      // the last command; the removal re-reads again under the lock.
      await store.refresh()
      await this.popFrom(store, selector)
    })
  }

  /** Open the list and pop whatever the reader takes. */
  list(cwdLabel: string): Promise<void> {
    return this.run(async store => {
      await store.refresh()
      if (store.entryCount === 0) {
        this.host.notice(NO_DRAFTS_MESSAGE)
        return
      }
      // The list is handed each entry with the index the bank gives it, so the
      // row a reader picks and the selector they could have typed agree.
      const rows = store.entries.map((entry, index) => ({ entry, index }))
      const picked = await this.host.pick(rows, cwdLabel)
      if (picked === undefined) return
      await this.popFrom(store, picked)
    })
  }

  /** Delete one draft without using it. */
  drop(selector: string | undefined): Promise<void> {
    return this.run(async store => {
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
    return this.run(async store => {
      await store.refresh()
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
  private async popFrom(store: StashStore, selector: string | undefined): Promise<void> {
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

  private async ensure(): Promise<StashStore> {
    if (this.store !== undefined) return this.store
    const store = await loadStashStore(this.paths, this.now, this.write)
    this.store = store
    return store
  }

  private run(operation: (store: StashStore) => Promise<void>): Promise<void> {
    return this.enqueue(async () => {
      try {
        await operation(await this.ensure())
      } catch (error) {
        this.host.notice(describeFailure(error))
      } finally {
        this.sync()
      }
    })
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const run = this.tail.then(operation, operation)
    this.tail = run.catch(() => undefined)
    return run
  }

  /** Publish the bank's size and any quarantine the last read produced. */
  private sync(): void {
    if (this.store !== undefined) {
      this.count = this.store.entryCount
      const quarantine = this.store.takeQuarantine()
      if (quarantine !== undefined) {
        const durability = quarantine.syncFailed ? CORRUPT_RECOVERY_UNSYNCED_MESSAGE : ''
        this.host.notice(`${CORRUPT_RECOVERY_MESSAGE} ${quarantine.path}${durability}`)
      }
    }
    this.host.render()
  }
}
