import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  PICKER_LIMIT,
  createSessionHistory,
  readSessionTitle,
  type SessionHistory,
  type StoredSession,
} from '../agent/history.ts'
import type { Keymap } from '../input/actions.ts'
import { SessionPicker } from '../ui/picker.ts'

/**
 * Titles read at once.
 *
 * Every title costs a log read, and the list is already on screen without them,
 * so they are pipelined to keep the wait near the slowest log rather than the
 * sum of them — bounded, because a hundred parallel reads is a disk storm the
 * reader would feel elsewhere.
 */
const TITLE_CONCURRENCY = 4

/**
 * What the stored-session owner needs from the surface that composes it.
 *
 * The keys are read at call time, because a settings edit while the list is
 * open moves the chords its hints name; the picker operation is a port rather
 * than an import, because the keyboard's lifetime belongs to the surface.
 */
export interface SessionPickerPorts {
  readonly keymap: () => Keymap
  readonly notice: (text: string) => void
  readonly render: () => void
  /**
   * Reject when this run cannot open that session under the mode it named.
   *
   * The composing surface owns what a mode is and which one this run named, so
   * it decides when there is a disagreement to look for at all.
   */
  readonly validateStoredPreset: (id: string) => Promise<void>
  /** Take the keyboard for the list and answer with the id it settled on. */
  readonly openPicker: (
    picker: SessionPicker,
    vet?: (id: string) => Promise<string | undefined>,
  ) => Promise<string | undefined>
}

/** The one read the composing surface routes to this owner. */
export interface SessionPickerChoice {
  /** Which stored session to open, or undefined when the reader asked for none. */
  readonly chooseSession: () => Promise<SessionId | undefined>
}

/**
 * The stored sessions a bare `--resume` asks the reader to choose between.
 *
 * The list is drawn by id before any log is opened: reading every title first
 * would make the picker as slow as the slowest session, and a session whose
 * log this build cannot read is still one the reader may want back.
 */
export function createSessionPicker(ctx: Context, ports: SessionPickerPorts): SessionPickerChoice {
  /** Title the listed sessions without making the reader wait for the slowest log. */
  const loadTitles = async (
    history: SessionHistory,
    sessions: readonly StoredSession[],
    titles: Map<string, string>,
  ): Promise<void> => {
    const queue = [...sessions]
    const worker = async (): Promise<void> => {
      for (;;) {
        const next = queue.shift()
        if (next === undefined) return
        try {
          const title = await readSessionTitle(history, next)
          if (title === undefined) continue
          titles.set(next.id, title)
          ports.render()
        } catch {
          // A log this build cannot read stays listed by id; the picker is not
          // the place to explain storage, and one bad session is not the list.
        }
      }
    }
    await Promise.all(Array.from({ length: TITLE_CONCURRENCY }, worker))
  }

  /**
   * The stored list, or undefined after telling the reader why there is none.
   *
   * No storage, an empty history, and a listing that throws all end the same way
   * — there is nothing to pick from — and none of them is worth ending the run
   * over, so each is a notice rather than a failure.
   */
  const storedSessions = async (): Promise<{ history: SessionHistory; sessions: readonly StoredSession[] } | undefined> => {
    const history = createSessionHistory(ctx)
    if (history === undefined) {
      ports.notice('this profile has no session storage, so there is nothing to resume')
      ports.render()
      return undefined
    }
    try {
      const sessions = await history.list(PICKER_LIMIT)
      if (sessions.length === 0) {
        ports.notice('no stored sessions to resume')
        ports.render()
        return undefined
      }
      return { history, sessions }
    } catch (error) {
      ports.notice(`could not list stored sessions: ${error instanceof Error ? error.message : String(error)}`)
      ports.render()
      return undefined
    }
  }

  /**
   * Why this run cannot open a stored session, or undefined when it can.
   *
   * A session runs the mode its own log recorded, so a `--preset` that
   * disagrees with it can only be refused: the picker asks first so the refusal
   * lands in the list rather than after the terminal has been handed back.
   */
  const refuseReason = async (id: string): Promise<string | undefined> => {
    try {
      await ports.validateStoredPreset(id)
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  /**
   * Take the keyboard for a picker.
   *
   * The list is already in hand, so the picker is interactive immediately while
   * the titles that make its rows recognizable stream in behind it.
   */
  const askForSession = async (history: SessionHistory, sessions: readonly StoredSession[]): Promise<SessionId | undefined> => {
    const titles = new Map<string, string>()
    void loadTitles(history, sessions, titles)
    const picked = await ports.openPicker(new SessionPicker(sessions, () => titles, undefined, ports.keymap), refuseReason)
    return picked === undefined ? undefined : SessionId(picked)
  }

  const chooseSession = async (): Promise<SessionId | undefined> => {
    const listed = await storedSessions()
    return listed === undefined ? undefined : askForSession(listed.history, listed.sessions)
  }

  return { chooseSession }
}
