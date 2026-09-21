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
import type { ResolvedEntry, StashEntry } from './stash/schema.ts'
import {
  loadStashStore,
  UnsupportedStashSchemaError,
  type StashStore,
  type StashWriter,
} from './stash/store.ts'

const EDITOR_BLOCKED_MESSAGE = 'clear or stash the current draft before applying or popping'
const NOTHING_TO_STASH_MESSAGE = 'nothing to stash'
const NO_DRAFTS_MESSAGE = 'no stashed drafts'
const STASH_USAGE_MESSAGE = 'usage: /stash <draft>'
const STASHED_MESSAGE = 'Stashed [0]'
const CORRUPT_RECOVERY_MESSAGE = 'corrupt stash data was quarantined to'

const appliedMessage = (index: number): string => `Applied [${index}]`
const poppedMessage = (index: number): string => `Popped [${index}]`
const droppedMessage = (index: number): string => `Dropped [${index}]`
const clearedMessage = (count: number): string => `Cleared ${count} draft${count === 1 ? '' : 's'}`
const selectorMissingMessage = (selector: string): string => `no stash matching "${selector}"`
const committedMessage = (error: StashCommittedError, done: string): string =>
  `${done}, but the ${error.failure.phase} step failed`
const removalFailedMessage = (error: unknown, done: string): string =>
  `${done}, but removing the entry failed: ${error instanceof Error ? error.message : 'unknown error'}`

/**
 * Everything the stash needs from the surface.
 *
 * The surface owns the editor and the picker, so the stash asks for text and
 * hands back text; it never reaches into a component of its own. `render` is
 * called after every state change so the status count follows the bank.
 */
export interface StashHost {
  /** The draft as written, with a pasted block expanded back to its text. */
  getEditorText(): string
  setEditorText(text: string): void
  notice(message: string): void
  /** Ask the reader which entry to take, by id; undefined when they leave. */
  pick(entries: readonly StashEntry[], cwdLabel: string): Promise<string | undefined>
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

  /** Persist one supplied draft; the editor is never read or changed. */
  stashText(text: string): Promise<void> {
    return this.run(async store => {
      if (text.trim() === '') {
        this.host.notice(STASH_USAGE_MESSAGE)
        return
      }
      await store.add({ text })
      this.host.notice(STASHED_MESSAGE)
    })
  }

  /** Persist the current editor draft, clearing it only after a successful write. */
  stashEditor(): Promise<void> {
    return this.run(async store => {
      const text = this.host.getEditorText()
      if (text.trim() === '') {
        this.host.notice(NOTHING_TO_STASH_MESSAGE)
        return
      }
      await store.add({ text })
      // Only clear what was actually persisted: a draft edited while the write
      // ran belongs to the reader, not to the bank.
      if (this.host.getEditorText() === text) this.host.setEditorText('')
      this.host.notice(STASHED_MESSAGE)
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
      const picked = await this.host.pick(store.entries, cwdLabel)
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

  /** Confirm, then delete every draft in this directory. */
  clear(): Promise<void> {
    return this.run(async store => {
      await store.refresh()
      const count = store.entryCount
      if (count === 0) {
        this.host.notice(NO_DRAFTS_MESSAGE)
        return
      }
      if (!(await this.host.confirm(count))) return
      let removed = count
      let warning: string | undefined
      try {
        removed = await store.clear()
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
    if (this.host.getEditorText().trim() === '') return true
    this.host.notice(EDITOR_BLOCKED_MESSAGE)
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
      const quarantine = this.store.takeQuarantinePath()
      if (quarantine !== undefined) this.host.notice(`${CORRUPT_RECOVERY_MESSAGE} ${quarantine}`)
    }
    this.host.render()
  }
}
