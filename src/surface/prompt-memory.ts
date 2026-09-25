import type { SessionId } from '@deepseek-ai/dsh-session'
import { createPromptHistory } from '../agent/prompt-history.ts'
import { ghostSuffix } from '../input/ghost.ts'
import type { Keymap } from '../input/actions.ts'
import { PromptStash } from '../stash.ts'
import type { TuiTheme } from '../theme.ts'
import { resetSequence } from '../theme-resolver.ts'
import { TUI_SETTINGS_NAMESPACE } from '../theme-settings.ts'
import type { GhostBrush } from '../ui/editor.ts'
import { HistoryPicker } from '../ui/history-picker.ts'
import type { PickerAction, PickerCard } from '../ui/picker.ts'
import { confirmedClear, StashConfirmPicker, StashPicker } from '../ui/stash-picker.ts'

/** Reverse video for the cell the cursor occupies, so a ghost keeps the cursor visible. */
const GHOST_CURSOR_PREFIX = '\u001b[7m'

/**
 * What a list has to answer to be driven by whoever owns the keyboard.
 *
 * This owner raises the lists and hands them over; the overlay they are drawn
 * in, the vetting of a pick, and how long a list may hold the keyboard stay
 * with the modal owner, which is why they arrive as a port.
 */
export interface MemoryPicker {
  handleKey(data: string): PickerAction | undefined
  card(window?: number): PickerCard
  setNote(text: string | undefined): void
}

/**
 * What the prompt's memory needs from the surface that composes it.
 *
 * The history switches are read at call time rather than captured: the
 * settings document is hot-reloaded, and a copy taken here would pin this
 * surface to the settings of the day it loaded. The theme is read through its
 * delegate for the same reason, and the editor and the picker are ports
 * because the widget and the keyboard lifetime are the surface's own.
 */
export interface PromptMemoryPorts {
  readonly historyEnabled: () => boolean
  readonly historyGhost: () => boolean
  readonly historyMaxEntries: () => number
  readonly theme: TuiTheme
  readonly keymap: () => Keymap
  readonly notice: (message: string) => void
  readonly render: () => void
  /** The draft as written, with a pasted block expanded back to its text. */
  readonly editorText: () => string
  readonly setEditorText: (text: string) => void
  /** Whether the prompt bar belongs to the reader rather than to a question. */
  readonly editorAvailable: () => boolean
  /** The session this surface drives, which is the one its drafts belong to. */
  readonly activeSession: () => SessionId
  readonly openPicker: (picker: MemoryPicker) => Promise<string | undefined>
}

/** The prompt's memory of itself, and the operations the surface routes to it. */
export interface PromptMemory {
  /** The dimmed completion the editor draws from recorded prompts. */
  readonly ghostBrush: GhostBrush
  /** Reverse search over recorded prompts, seeded with whatever is in the bar. */
  readonly openHistoryPicker: () => Promise<void>
  /** Record a submitted line; the setting decides whether any of it is kept. */
  readonly record: (text: string) => void
  /** Show where history is kept, or forget it; the file is global to this machine. */
  readonly runHistoryCommand: (argument: string) => void
  /**
   * Build the bank for the session this surface drives, and hand it back.
   *
   * Handed back rather than kept here alone: the surface's status count and the
   * parked-draft commands it routes read the same instance, and both exist
   * before a pick could reach a picker — which is why the bank cannot be built
   * with the rest of this owner.
   */
  readonly buildStash: () => PromptStash
  /** Follow the session just opened, so the footer counts that session's drafts. */
  readonly sessionOpened: () => void
}

/**
 * The memory the prompt keeps of what was typed, and what it offers back.
 *
 * Two stores, one subject: the prompt history is global and written from every
 * submitted line, while the stash parks a draft for the session in force. Both
 * are read through the same editor and both answer in a list, so they share the
 * one owner that knows what the reader is looking at.
 */
export function createPromptMemory(ports: PromptMemoryPorts): PromptMemory {
  /**
   * The reader's prompt history: global across projects, recorded from every
   * submitted line, and offered back as they type. Built before the bar exists
   * so its first load cannot race the first suggestion.
   */
  const promptHistory = createPromptHistory({
    cap: () => ports.historyMaxEntries(),
    warn: message => {
      ports.notice(message)
      ports.render()
    },
  })
  /**
   * The dimmed completion drawn from recorded prompts.
   *
   * Colour is the affordance: with styling off the suggestion would be
   * unreadable text the reader could still accept, which is worse than none.
   * The cursor cell is also reversed so the cursor stays visible on the ghost.
   */
  const ghostBrush: GhostBrush = {
    enabled: () => ports.historyEnabled() && ports.historyGhost() && ports.theme.color && ports.theme.visible('editor.ghost'),
    suggestion: input => ghostSuffix({ entries: promptHistory.entries(), ...input }),
    paint: (text, cell) => {
      const styled = ports.theme.style('editor.ghost', text)
      return cell === 'cursor' ? GHOST_CURSOR_PREFIX + styled + resetSequence() : styled
    },
  }
  /**
   * The bank the surface asked for, as this owner's own reference to it.
   *
   * Late-bound because the surface builds it where a pick can reach a picker:
   * this reference exists before the bank does, and a session opened before
   * then has none to follow.
   */
  let stash: PromptStash | undefined

  /**
   * Reverse search over recorded prompts, seeded with whatever is in the bar.
   *
   * A pick replaces the draft; a cancel leaves it exactly as it was, because the
   * list was opened to look rather than to lose what is already typed.
   */
  const openHistoryPicker = async (): Promise<void> => {
    if (!ports.historyEnabled()) {
      ports.notice('prompt history is disabled in ' + TUI_SETTINGS_NAMESPACE + ' settings')
      ports.render()
      return
    }
    if (promptHistory.entries().length === 0) {
      const blocked = promptHistory.blockedReason()
      ports.notice(blocked === undefined ? 'no prompt history yet' : 'prompt history is unavailable: ' + blocked)
      ports.render()
      return
    }
    // The expanded text is what the reader wrote; a large paste sits in the bar
    // as a marker, and seeding with it would filter out the prompt it came from.
    const picked = await ports.openPicker(new HistoryPicker(() => promptHistory.entries(), ports.editorText(), () => ports.keymap()))
    if (picked === undefined) return
    ports.setEditorText(picked)
    ports.render()
  }

  /** Show where history is kept, or forget it; the file is global to this machine. */
  const runHistoryCommand = (argument: string): void => {
    // The line that asked for this is recorded before the command runs, but that
    // write rides the store's queue; waiting for it lets the count describe the
    // file the reader has, not the state before their own line landed.
    void promptHistory.flush().then(() => {
      if (argument === '') {
        const count = promptHistory.entries().length
        const blocked = promptHistory.blockedReason()
        ports.notice([
          count + (count === 1 ? ' prompt recorded' : ' prompts recorded'),
          promptHistory.path(),
          blocked === undefined ? undefined : 'writes disabled: ' + blocked,
        ].filter(part => part !== undefined).join(' · '))
        ports.render()
        return
      }
      if (argument !== 'clear') {
        ports.notice('usage: /history shows where history is kept · /history clear forgets every prompt')
        ports.render()
        return
      }
      // A refused write cannot remove anything, so saying "forgot 0 prompts"
      // would describe a successful clear the file never had.
      const blocked = promptHistory.blockedReason()
      if (blocked !== undefined) {
        ports.notice('prompt history is unavailable: ' + blocked)
        ports.render()
        return
      }
      return promptHistory.clear().then(removed => {
        ports.notice('forgot ' + removed + (removed === 1 ? ' prompt' : ' prompts'))
        ports.render()
      })
    }).catch(error => {
      // The store keeps what the file still holds, so the reader is told the
      // clear failed rather than being shown a count that never landed.
      ports.notice('could not clear prompt history: ' + (error instanceof Error ? error.message : String(error)))
      ports.render()
    })
  }

  /**
   * The prompt bank for the session this surface drives.
   *
   * The surface owns the editor, the picker, and the notices, so the bank is
   * handed the few things it needs to reach them and nothing else: the commands
   * stay free of terminal state and are exercised without one in the tests.
   */
  const buildStash = (): PromptStash => {
    stash = new PromptStash(
      {
        getEditorText: () => ports.editorText(),
        setEditorText: text => ports.setEditorText(text),
        editorIsAvailable: () => ports.editorAvailable(),
        notice: message => ports.notice(message),
        pick: (entries, label) => ports.openPicker(new StashPicker(entries, label, () => ports.keymap())),
        confirm: async count => confirmedClear(await ports.openPicker(new StashConfirmPicker(count, () => ports.keymap()))),
        render: () => ports.render(),
      },
      // The bank follows the session this surface drives, not the directory it
      // runs in: two terminals in one checkout keep separate drafts, and a resume
      // finds the ones it parked. Read per command so a switch retargets it.
      { sessionId: () => String(ports.activeSession()) },
    )
    return stash
  }

  /**
   * Follow the session the surface has just opened.
   *
   * The bank follows the session, so the footer stops counting the drafts of
   * the session just left and the next command reads this session's file.
   */
  const sessionOpened = (): void => {
    void stash?.open()
  }

  /** Record a submitted line, when the reader has recording on at all. */
  const record = (text: string): void => {
    if (ports.historyEnabled()) promptHistory.record(text)
  }

  return {
    ghostBrush,
    openHistoryPicker,
    record,
    runHistoryCommand,
    buildStash,
    sessionOpened,
  }
}
