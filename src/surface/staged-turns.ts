import { randomUUID } from 'node:crypto'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ForkEvent } from '../agent/fork.ts'
import type { ForkInheritance, TuiAgent } from '../agent/host.ts'
import {
  hiddenTail,
  NO_UNDO,
  redoStep,
  resetUndo,
  type TurnPoint,
  turnsOf,
  UNDO_TURN_SETTLE_MS,
  type UndoState,
  undoStep,
} from '../agent/undo.ts'
import { failureNotice } from '../failure-notice.ts'

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

const UNDO_CURSOR_STALE = 'the undone turns are no longer in this session log'

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
  readonly openSession: (
    id: SessionId,
    resume: boolean,
    fork?: ForkInheritance,
  ) => Promise<TuiAgent>
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
  const state: StagedState = { cursor: NO_UNDO, cut: undefined, pending: false, settled: undefined }
  return {
    stagedCutoff: () => state.cut,
    cursor: () => state.cursor,
    sessionOpened: (id) => {
      state.cursor = resetUndo(id)
      state.cut = undefined
    },
    undo: () => runUndoCommand(ports, state),
    redo: () => runRedoCommand(ports, state),
    send: (text) => commitStagedSend(ports, state, text),
    // The turn/end the cursor may be waiting on, which only the composer hears.
    turnSettled: () => {
      state.settled?.()
    },
  }
}

/** What undo, redo, and send share: one record, so each step stands alone and sees the others' writes. */
interface StagedState {
  /** The staged cursor for the session this terminal drives. */
  cursor: UndoState
  /** Event index the transcript must not fold past while turns are hidden. */
  cut: number | undefined
  /** Whether an undo is settling an interrupt, so a second press cannot race it. */
  pending: boolean
  /** Resolver for the turn/end an undo is waiting on, set only while waiting. */
  settled: (() => void) | undefined
}

/** The closed turns of the session this terminal drives, newest last. */
async function currentTurns(ports: StagedTurnPorts): Promise<readonly TurnPoint[]> {
  return turnsOf(await ports.sessionEvents(ports.activeSession()))
}

/** Fold the transcript through the staged cut, or the whole log at the tip. */
async function redrawStaged(ports: StagedTurnPorts, state: StagedState): Promise<void> {
  ports.resetTranscript()
  await ports.foldTranscript(ports.activeSession(), state.cut)
}

/** Park queued prompts one per bank entry, newest first so popping replays queue order. */
async function parkQueued(ports: StagedTurnPorts, queued: readonly string[]): Promise<void> {
  for (const text of [...queued].reverse()) await ports.parkPrompt(text)
}

/** Wait for the interrupted turn to close, bounded so undo can give up honestly. */
function waitForTurnEnd(state: StagedState, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      state.settled = undefined
      resolve(false)
    }, timeoutMs)
    state.settled = () => {
      clearTimeout(timer)
      state.settled = undefined
      resolve(true)
    }
  })
}

/**
 * Stop the running turn and empty the inbox so the cut lands on a closed
 * turn/end; queued prompts are parked first because cancelling drops them.
 *
 * Returns undefined when the reader's words cannot be kept: a queue with no
 * bank to park it in, a park that fails, or a turn that will not close. All
 * leave the cursor untouched, so the transcript keeps showing what the model
 * actually saw; a
 * number is how many queued prompts were parked before the turn was stopped.
 */
async function settleForUndo(
  ports: StagedTurnPorts,
  state: StagedState,
): Promise<number | undefined> {
  const queued = ports.queuedPrompts()
  if (!ports.turnRunning() && queued.length === 0) return 0
  if (queued.length > 0 && !ports.canPark()) {
    ports.notice('queued prompts have no stash to park in; undo cancelled')
    ports.render()
    return undefined
  }
  // Park before the interrupt: cancelling the turn drops the queue. A rejected
  // park must leave unsaved words queued; stash notices alone do not reject.
  if (queued.length > 0) {
    try {
      await parkQueued(ports, queued)
    } catch {
      // Earlier entries may already be stored, but that does not prove every
      // prompt has a saved copy. Preserve the queue rather than risk losing words.
      ports.notice('could not park the queued prompts; undo cancelled')
      ports.render()
      return undefined
    }
  }
  ports.drivingAgent()?.interrupt()
  if (ports.turnRunning() && !(await waitForTurnEnd(state, UNDO_TURN_SETTLE_MS))) {
    ports.notice('could not stop the turn; undo cancelled')
    ports.render()
    return undefined
  }
  return queued.length
}

function runUndoCommand(ports: StagedTurnPorts, state: StagedState): void {
  if (state.pending) return
  state.pending = true
  // A cursor counts one session's turns, so an undo that outlives a session
  // switch must not write the old session's step into the new session's bar.
  const pressedFor = ports.activeSession()
  const overtaken = (): boolean => ports.activeSession() !== pressedFor
  void undoOnce(ports, state, overtaken)
    .catch((error: unknown) => {
      ports.notice(failureNotice('undo failed', error))
      ports.render()
    })
    .finally(() => {
      state.pending = false
    })
}

/** One undo, from the press to the redraw; `overtaken` says the reader has left that session. */
async function undoOnce(
  ports: StagedTurnPorts,
  state: StagedState,
  overtaken: () => boolean,
): Promise<void> {
  if (ports.viewingChild()) {
    ports.notice('undo works on the session this terminal drives · ctrl+b comes back')
    ports.render()
    return
  }
  const turns = await currentTurns(ports)
  if (overtaken()) return
  if (state.cursor.hidden >= turns.length && !ports.turnRunning()) {
    ports.notice('nothing to undo')
    ports.render()
    return
  }
  const draft = ports.draft()
  // Text this state itself restored is not the reader's draft, so undoing
  // again must not park it and end up with two copies.
  const holdsDraft = draft !== '' && draft !== state.cursor.lastRestored
  if (holdsDraft && !ports.canPark()) {
    ports.notice('the bar holds a draft and there is no stash to park it in; undo cancelled')
    ports.render()
    return
  }
  const parked = await settleForUndo(ports, state)
  if (parked === undefined) return
  if (overtaken()) return
  const settledTurns = await currentTurns(ports)
  if (overtaken()) return
  const next = undoStep(state.cursor, settledTurns)
  if (next === undefined) {
    ports.notice('nothing to undo')
    ports.render()
    return
  }
  if (holdsDraft) {
    await ports.parkPrompt(draft)
    if (overtaken()) return
    ports.notice('the draft in the bar was parked in the stash')
  }
  state.cursor = next
  state.cut = hiddenTail(next, settledTurns)?.seedCount
  await redrawStaged(ports, state)
  if (overtaken()) return
  ports.writeDraft(next.lastRestored)
  ports.notice(undoNotice(next.hidden, parked))
  ports.render()
}

/** The parking count rides the undo notice: a notice of its own would be replaced before the frame could show it. */
function undoNotice(hidden: number, parked: number): string {
  const parkedNote =
    parked === 0 ? '' : ` · ${parked} queued prompt${parked === 1 ? '' : 's'} parked in the stash`
  return `undo · ${hidden} prompt${hidden === 1 ? '' : 's'} hidden${parkedNote} · prefix r redo`
}

function runRedoCommand(ports: StagedTurnPorts, state: StagedState): void {
  // An undo that is still settling owns the cursor; a redo now would step
  // the state that undo is about to replace, so it is dropped like a second
  // undo press.
  if (state.pending) return
  void (async () => {
    if (ports.viewingChild()) {
      ports.notice('redo works on the session this terminal drives · ctrl+b comes back')
      ports.render()
      return
    }
    const turns = await currentTurns(ports)
    const before = ports.draft()
    const restored = state.cursor.lastRestored
    const next = redoStep(state.cursor, turns)
    if (next === undefined) {
      ports.notice('nothing to redo')
      ports.render()
      return
    }
    state.cursor = next
    state.cut = hiddenTail(next, turns)?.seedCount
    await redrawStaged(ports, state)
    // A composer the reader edited is theirs; only text this state wrote is replaced.
    if (before === restored) ports.writeDraft(next.lastRestored)
    ports.notice(
      next.hidden === 0
        ? 'redo · back at the newest prompt'
        : `redo · ${next.hidden} prompt${next.hidden === 1 ? '' : 's'} hidden`,
    )
    ports.render()
  })().catch((error: unknown) => {
    ports.notice(failureNotice('redo failed', error))
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
async function commitStagedSend(
  ports: StagedTurnPorts,
  state: StagedState,
  text: string,
): Promise<void> {
  try {
    const previous = ports.drivingAgent()
    if (previous === undefined) {
      ports.notice('the agent is still starting; try again in a moment')
      ports.render()
      return
    }
    if (state.cursor.hidden === 0) {
      previous.submit(text)
      return
    }
    const source = ports.activeSession()
    const events = await ports.sessionEvents(source)
    const turns = turnsOf(events)
    // Branch from the oldest hidden turn to exclude the whole undone suffix.
    // This assumes the cursor still matches the source log after the await.
    const tail = hiddenTail(state.cursor, turns)
    // Refuse before the outgoing agent is disposed, so the reader keeps a driver.
    if (tail === undefined) throw new Error(UNDO_CURSOR_STALE)
    const seed = events.slice(0, tail.seedCount)
    const childId = SessionId(`tui-session-${randomUUID()}`)
    // The source log preserves the undone turns, not this agent; disposal is
    // not rolled back if the child cannot open, so a send failure can leave no driver.
    await ports.disposeOutgoing()
    const opened = await ports.openSession(
      childId,
      false,
      seed.length === 0 ? undefined : { from: source, events: seed },
    )
    ports.notice(`continuing in a new branch · ${source} keeps the undone turns`)
    opened.submit(text)
  } catch (error) {
    ports.notice(failureNotice('could not send', error))
    ports.render()
  }
}
