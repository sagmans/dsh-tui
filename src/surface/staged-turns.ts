import { randomUUID } from 'node:crypto'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ForkEvent } from '../agent/fork.ts'
import type { ForkInheritance, TuiAgent } from '../agent/host.ts'
import {
  hiddenTail,
  NO_UNDO,
  redoStep,
  resetUndo,
  turnsOf,
  UNDO_TURN_SETTLE_MS,
  undoStep,
  type TurnPoint,
  type UndoState,
} from '../agent/undo.ts'

/**
 * The staged-turn policy: the cursor over the live log, and the prompts parked
 * behind it.
 *
 * Undo never deletes a prompt. It moves a cursor over the closed turns, folds
 * the transcript back to a cut that stops before the hidden ones, and hands the
 * reader's own words back to the composer. A send while turns are hidden cannot
 * continue in place — the model would then see the prompts the reader undid —
 * so it branches from the visible prefix instead.
 */

/**
 * What the staged-turn owner needs from the surface that composes it.
 *
 * Every read is taken at call time: the session, the draft, the queue and the
 * agent in service all move while an undo settles an interrupt, and a captured
 * copy would park the reader's draft in a session they already left.
 */
export interface StagedTurnPorts {
  /** Whether the transcript shows a child, where neither command belongs. */
  readonly viewingChild: () => boolean
  /** The session this terminal drives, which owns the only log a cursor counts. */
  readonly activeSession: () => SessionId
  /** Every event of a session, which is what the turns are derived from. */
  readonly sessionEvents: (id: SessionId) => Promise<readonly ForkEvent[]>
  /** Drop the folded transcript, so the next fold starts from nothing. */
  readonly resetTranscript: () => void
  /** Fold the transcript to an event index, or over the whole log at the tip. */
  readonly foldTranscript: (id: SessionId, cutoff: number | undefined) => Promise<unknown>
  /** The agent in service, which a plain send submits to and a staged one replaces. */
  readonly drivingAgent: () => TuiAgent | undefined
  /**
   * The lifecycle owner's one replacement boundary: stop the agent in service
   * and let go of everything that projected it.
   */
  readonly disposeOutgoing: () => Promise<void>
  /** Start the agent for a session, which is what a replacement joins. */
  readonly openSession: (id: SessionId, resume: boolean, fork?: ForkInheritance) => Promise<TuiAgent>
  /** The prompts queued on the driven agent, which an interrupt would drop. */
  readonly queuedPrompts: () => readonly string[]
  /** Whether a bank exists to park into, which is how the reader's words survive. */
  readonly canPark: () => boolean
  /** Park one prompt, in the order the queue replay needs. */
  readonly parkPrompt: (text: string) => Promise<void>
  /** Whether a turn is open, which the cursor must not cut through. */
  readonly turnRunning: () => boolean
  /** The text the bar holds, which is the reader's draft until this owner writes it. */
  readonly draft: () => string
  /** Put text back in the bar. */
  readonly writeDraft: (text: string) => void
  readonly notice: (message: string) => void
  readonly render: () => void
}

/** The staged cursor and the operations the composer routes its commands to. */
export interface StagedTurns {
  /** Event index the transcript must not fold past while turns are hidden. */
  readonly stagedCutoff: () => number | undefined
  /** The cursor over this session's closed turns. */
  readonly cursor: () => UndoState
  /** Whether an undo is settling an interrupt, so a second press cannot race it. */
  readonly pending: () => boolean
  /**
   * The cursor at the tip of the session just opened.
   *
   * A cursor counts the turns of one log, so a session that opens takes a fresh
   * one; the cut goes with it, because a hidden count means nothing on a
   * transcript nothing has been folded from.
   */
  readonly sessionOpened: (id: SessionId) => void
  readonly undo: () => void
  readonly redo: () => void
  /** Send the reader's prompt, branching first when turns are hidden. */
  readonly send: (text: string) => Promise<void>
  /** The turn/end the cursor may be waiting on, which the composer's listener hears. */
  readonly turnSettled: () => void
}

export function createStagedTurns(ports: StagedTurnPorts): StagedTurns {
  /** The staged cursor for the session this terminal drives. */
  let cursor: UndoState = NO_UNDO
  /** Event index the transcript must not fold past while turns are hidden. */
  let cut: number | undefined
  /** Whether an undo is settling an interrupt, so a second press cannot race it. */
  let pending = false
  /** Resolver for the turn/end an undo is waiting on, set only while waiting. */
  let settled: (() => void) | undefined

  /** The closed turns of the session this terminal drives, newest last. */
  const currentTurns = async (): Promise<readonly TurnPoint[]> =>
    turnsOf(await ports.sessionEvents(ports.activeSession()))

  /** Fold the transcript through the staged cut, or the whole log at the tip. */
  const redrawStaged = async (): Promise<void> => {
    ports.resetTranscript()
    await ports.foldTranscript(ports.activeSession(), cut)
  }

  /** Park queued prompts one per bank entry, newest first so popping replays queue order. */
  const parkQueued = async (queued: readonly string[]): Promise<void> => {
    for (const text of [...queued].reverse()) await ports.parkPrompt(text)
  }

  /** Wait for the interrupted turn to close, bounded so undo can give up honestly. */
  const waitForTurnEnd = (timeoutMs: number): Promise<boolean> =>
    new Promise(resolve => {
      const timer = setTimeout(() => {
        settled = undefined
        resolve(false)
      }, timeoutMs)
      settled = () => {
        clearTimeout(timer)
        settled = undefined
        resolve(true)
      }
    })

  /**
   * Stop the running turn and empty the inbox so the cut lands on a closed
   * turn/end; queued prompts are parked first because cancelling drops them.
   *
   * Returns undefined when the reader's words cannot be kept: a queue with no
   * bank to park it in, or a turn that will not close. Both leave the cursor
   * untouched, so the transcript keeps showing what the model actually saw; a
   * number is how many queued prompts were parked before the turn was stopped.
   */
  const settleForUndo = async (): Promise<number | undefined> => {
    const queued = ports.queuedPrompts()
    if (!ports.turnRunning() && queued.length === 0) return 0
    if (queued.length > 0 && !ports.canPark()) {
      ports.notice('queued prompts have no stash to park in; undo cancelled')
      ports.render()
      return undefined
    }
    ports.drivingAgent()?.interrupt()
    if (queued.length > 0) await parkQueued(queued)
    if (ports.turnRunning() && !(await waitForTurnEnd(UNDO_TURN_SETTLE_MS))) {
      ports.notice('could not stop the turn; undo cancelled')
      ports.render()
      return undefined
    }
    return queued.length
  }

  const runUndoCommand = (): void => {
    if (pending) return
    pending = true
    void (async () => {
      if (ports.viewingChild()) {
        ports.notice('undo works on the session this terminal drives · ctrl+b comes back')
        ports.render()
        return
      }
      const turns = await currentTurns()
      if (cursor.hidden >= turns.length && !ports.turnRunning()) {
        ports.notice('nothing to undo')
        ports.render()
        return
      }
      const draft = ports.draft()
      // Text this state itself restored is not the reader's draft, so undoing
      // again must not park it and end up with two copies.
      const holdsDraft = draft !== '' && draft !== cursor.lastRestored
      if (holdsDraft && !ports.canPark()) {
        ports.notice('the bar holds a draft and there is no stash to park it in; undo cancelled')
        ports.render()
        return
      }
      const parked = await settleForUndo()
      if (parked === undefined) return
      const settledTurns = await currentTurns()
      const next = undoStep(cursor, settledTurns)
      if (next === undefined) {
        ports.notice('nothing to undo')
        ports.render()
        return
      }
      if (holdsDraft) {
        await ports.parkPrompt(draft)
        ports.notice('the draft in the bar was parked in the stash')
      }
      cursor = next
      cut = hiddenTail(next, settledTurns)?.seedCount
      await redrawStaged()
      ports.writeDraft(next.lastRestored)
      // The parking count rides the undo notice: a notice of its own would be
      // replaced before the frame could show it.
      const parkedNote = parked === 0 ? '' : ` · ${parked} queued prompt${parked === 1 ? '' : 's'} parked in the stash`
      ports.notice(`undo · ${next.hidden} prompt${next.hidden === 1 ? '' : 's'} hidden${parkedNote} · prefix r redo`)
      ports.render()
    })()
      .catch((error: unknown) => {
        ports.notice(`undo failed: ${error instanceof Error ? error.message : String(error)}`)
        ports.render()
      })
      .finally(() => {
        pending = false
      })
  }

  const runRedoCommand = (): void => {
    void (async () => {
      if (ports.viewingChild()) {
        ports.notice('redo works on the session this terminal drives · ctrl+b comes back')
        ports.render()
        return
      }
      const turns = await currentTurns()
      const before = ports.draft()
      const restored = cursor.lastRestored
      const next = redoStep(cursor, turns)
      if (next === undefined) {
        ports.notice('nothing to redo')
        ports.render()
        return
      }
      cursor = next
      cut = hiddenTail(next, turns)?.seedCount
      await redrawStaged()
      // A composer the reader edited is theirs; only text this state wrote is replaced.
      if (before === restored) ports.writeDraft(next.lastRestored)
      ports.notice(next.hidden === 0
        ? 'redo · back at the newest prompt'
        : `redo · ${next.hidden} prompt${next.hidden === 1 ? '' : 's'} hidden`)
      ports.render()
    })().catch((error: unknown) => {
      ports.notice(`redo failed: ${error instanceof Error ? error.message : String(error)}`)
      ports.render()
    })
  }

  /**
   * Send the reader's prompt, branching first when the transcript is staged.
   *
   * Context is derived from the log, so a send while turns are hidden has to
   * continue in a child seeded with the visible prefix; submitting in place would
   * show the model the prompts the reader undid. Every send passes through here so
   * the branch has one commit point, not one per caller.
   */
  const commitStagedSend = async (text: string): Promise<void> => {
    try {
      const previous = ports.drivingAgent()
      if (previous === undefined) {
        ports.notice('the agent is still starting; try again in a moment')
        ports.render()
        return
      }
      if (cursor.hidden === 0) {
        previous.submit(text)
        return
      }
      const source = ports.activeSession()
      const events = await ports.sessionEvents(source)
      const turns = turnsOf(events)
      const tail = hiddenTail(cursor, turns)
      const seed = tail === undefined ? [] : events.slice(0, tail.seedCount)
      const childId = SessionId(`tui-session-${randomUUID()}`)
      await ports.disposeOutgoing()
      const opened = await ports.openSession(childId, false, seed.length === 0 ? undefined : { from: source, events: seed })
      ports.notice(`continuing in a new branch · ${source} keeps the undone turns`)
      opened.submit(text)
    } catch (error) {
      ports.notice(`could not send: ${error instanceof Error ? error.message : String(error)}`)
      ports.render()
    }
  }

  return {
    stagedCutoff: () => cut,
    cursor: () => cursor,
    pending: () => pending,
    sessionOpened: id => {
      cursor = resetUndo(id)
      cut = undefined
    },
    undo: runUndoCommand,
    redo: runRedoCommand,
    send: commitStagedSend,
    // The turn/end the cursor may be waiting on, which only the composer hears.
    turnSettled: () => {
      settled?.()
    },
  }
}
