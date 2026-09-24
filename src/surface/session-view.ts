import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ForkEvent } from '../agent/fork.ts'
import { createSessionHistory } from '../agent/history.ts'
import { createToolPresenter } from '../agent/present.ts'
import { FoldCursor, ViewGeneration, replayIfCurrent } from '../fold-cursor.ts'
import { hintKeys, type Keymap } from '../input/actions.ts'
import { TranscriptModel } from '../transcript.ts'
import { WorkFold, type WorkState } from '../work.ts'

/** What the back hint names when the reader has unbound the key it would advertise. */
const BACK_HINT_FALLBACK = 'ctrl+b'

/** What the reader presses to leave a view they did not open. */
export const backHint = (map: Keymap): string => `${hintKeys(map, 'surface.back') || BACK_HINT_FALLBACK} returns to this session`

/**
 * What the transcript owner needs from the surface that composes it.
 *
 * The identity, the cutoff and the scope are read at call time: all three can
 * change between two folds, and a captured copy would fold — or degrade a card
 * through — the session this terminal drove before the reader moved.
 */
export interface SessionViewPorts {
  /** The session the transcript opens on, named by the run that launched this surface. */
  readonly initialSession: SessionId
  /** The session this terminal drives: commands, approvals, and the bell belong to it. */
  readonly drivenSession: () => SessionId
  /** Event index the transcript must not fold past while turns are hidden. */
  readonly stagedCutoff: () => number | undefined
  /** The world a folded card reads its tool through; a stored session has none. */
  readonly agentScope: (id: SessionId) => Agent | undefined
  /** A live session's own events, or undefined when this process does not run it. */
  readonly liveEvents: (id: SessionId) => readonly ForkEvent[] | undefined
  readonly render: () => void
}

/** The transcript on screen, and every read and operation the composing surface takes from it. */
export interface SessionView {
  /** The session the transcript is showing, which can be one of its children. */
  readonly viewed: () => SessionId
  readonly viewingChild: () => boolean
  readonly notice: (message: string) => void
  readonly marker: (text: string) => void
  readonly reportError: (error: unknown) => void
  /** The model the transcript is drawn from, and what an export writes out. */
  readonly model: TranscriptModel
  /** What the transcript folded: todos, the goal, and plan mode. */
  readonly workState: () => WorkState
  /** Every event of a session, from memory when this process runs it. */
  readonly sessionEvents: (id: SessionId) => Promise<readonly ForkEvent[]>
  /** The scope a folded card reads through. */
  readonly setPresentScope: (scope: Agent | undefined) => void
  /**
   * Drop that scope. Also the teardown disposer the composition root pushes.
   *
   * The presenter closure outlives the composition's own teardown, so it must
   * not keep an agent alive after its world unwinds.
   */
  readonly clearPresentScope: () => void
  /** Start a fresh transcript: every reset revokes reads started for the previous view. */
  readonly reset: () => () => boolean
  /** Show a session without folding it; the caller owns the fold that follows. */
  readonly setViewed: (id: SessionId) => void
  /** Fold one session's history, or the driven one's through a staged cutoff. */
  readonly fold: (id: SessionId, through?: number, current?: () => boolean) => Promise<number>
  /** Fold a stored log as a replay, which reports its own failure in a notice. */
  readonly replay: (id: SessionId) => Promise<void>
  /** Show another session in the transcript without leaving the one this terminal drives. */
  readonly show: (id: SessionId) => Promise<void>
  /** Come back to the transcript of the session this terminal drives. */
  readonly showDriven: () => Promise<void>
  /** The viewed half of one durable event: the fold and the repaint it earns. */
  readonly observe: (id: SessionId, event: ForkEvent) => void
  /**
   * Register the two listeners that follow the viewed agent's own stream.
   *
   * They are returned rather than pushed here so the composition root keeps one
   * ordered list of teardowns, which is unwound in reverse registration order.
   */
  readonly agentListeners: () => readonly (() => void)[]
}

/**
 * The transcript on screen: what is drawn, and never which agent is driven.
 *
 * The model, the work fold and the identity they are folded for are one owner
 * because the reader's view is one thing: a durable event reaches both folds,
 * and a switch of identity resets both. What this owner drives — the agent, its
 * staged cutoff, and the terminal it paints — stays with the surface that
 * composes it, so a reader can watch a child's conversation without moving the
 * commands, the approvals, or the bell.
 */
export function createSessionView(ctx: Context, ports: SessionViewPorts): SessionView {
  /**
   * The agent scope the tool presenter resolves against.
   *
   * Tools are registered in the scoped world the session's preset mounts, so a
   * card can only read its tool's own render intent while this names that
   * agent. It follows whatever session the transcript is folding, because a
   * child on screen reads through the child's scope, not the parent's.
   */
  let presentScope: Agent | undefined
  const model = new TranscriptModel(createToolPresenter(ctx, () => presentScope))
  const work = new WorkFold()
  /** The session the transcript is showing, which can be one of its children. */
  let viewedSession = ports.initialSession
  /** Only the newest transcript switch may finish an asynchronous stored-log read. */
  const viewGeneration = new ViewGeneration()
  /**
   * The fold's place in the viewed session's durable sequence.
   *
   * A resumed session is folded while its agent's loop is already live, so the
   * same event can reach the surface twice: once on the stream and once from the
   * log the fold is reading. The sequence number every durable event carries is
   * what tells the two apart.
   */
  const foldCursor = new FoldCursor()

  /** Every transcript reset revokes reads started for the previous view. */
  const reset = (): (() => boolean) => {
    const current = viewGeneration.begin()
    model.reset()
    work.reset()
    return current
  }

  /** Feed one durable event to everything that folds it. */
  const applyEvent = (event: { readonly type: string; readonly data?: unknown }): void => {
    model.apply(event)
    work.apply(event)
  }

  /**
   * Fold one durable event into the view, unless a staged cursor hides it.
   *
   * Undo never deletes, so the log keeps the hidden suffix; this filter is the
   * one place the transcript and the log disagree about where the session ends.
   */
  const applyDurable = (session: SessionId, event: ForkEvent): void => {
    const cut = ports.stagedCutoff()
    if (cut !== undefined && session === ports.drivenSession() && typeof event.seq === 'number' && event.seq >= cut) return
    if (foldCursor.accept(session, event)) applyEvent(event)
  }

  /**
   * Replay a stored session so a resumed run opens on the conversation the
   * reader left, not on an empty screen: the durable log is the transcript.
   */
  /**
   * Fold one session's history into the transcript.
   *
   * A live session answers from memory, which is the only source that includes
   * events not yet flushed and the only one that works for a child that has not
   * materialized; a session this process is not running falls back to storage.
   */
  const foldHistory = async (id: SessionId, through?: number, current: () => boolean = () => true): Promise<number> => {
    // Resolved before the fold so every card reads its tool through the scope
    // that actually registered it; a stored session nobody runs has none.
    presentScope = ports.agentScope(id)
    // Every fold starts a cleared transcript, so a session already known to the
    // cursor is read from its first event rather than from where it left off.
    foldCursor.reset()
    const inMemory = ports.liveEvents(id)
    if (inMemory !== undefined) {
      const events = through === undefined ? inMemory : inMemory.slice(0, through)
      for (const event of events) applyDurable(id, event)
      return events.length
    }
    // Only a live session can be staged: undo acts on the agent this terminal
    // drives, and a stored log has no cursor to hide a suffix from.
    const history = createSessionHistory(ctx)
    if (history === undefined) return 0
    return replayIfCurrent(() => history.read(id), current, event => applyDurable(id, event))
  }

  const replayHistory = async (id: SessionId): Promise<void> => {
    try {
      const folded = await foldHistory(id)
      if (folded > 0) model.notice(`replayed ${folded} events from the stored log`)
    } catch (error) {
      model.notice(`could not replay this session: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Show another session in the transcript without leaving this one.
   *
   * A delegation is an ordinary session, so the reader can read what a child is
   * doing rather than only that it exists; the agent this terminal drives does
   * not change, which keeps commands, approvals, and the bell where they were.
   */
  const showSession = async (id: SessionId): Promise<void> => {
    const previous = viewedSession
    const current = reset()
    viewedSession = id
    try {
      await foldHistory(id, undefined, current)
    } catch (error) {
      if (!current()) return
      model.notice(`could not read that session: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!current()) return
    const driven = ports.drivenSession()
    const returned = id === driven && previous !== driven
    model.marker(returned ? 'back to the session this terminal drives' : `viewing ${id}`)
    ports.render()
  }

  const showAgentSession = async (): Promise<void> => {
    await showSession(ports.drivenSession())
  }

  /** Every event of a session, from memory when this process runs it. */
  const sessionEvents = async (id: SessionId): Promise<readonly ForkEvent[]> => {
    const inMemory = ports.liveEvents(id)
    if (inMemory !== undefined) return inMemory
    const history = createSessionHistory(ctx)
    return history === undefined ? [] : history.read(id)
  }

  /**
   * Fold one durable event of the session on screen, and repaint.
   *
   * The caller filters on the identity it drives first: the surface state —
   * activity, timer, title, bell, job board — belongs to that agent even while
   * a child is on screen.
   */
  const observe = (id: SessionId, event: ForkEvent): void => {
    if (id !== viewedSession) return
    presentScope = ports.agentScope(id)
    applyDurable(id, event)
    ports.render()
  }

  /**
   * The listeners that follow the viewed agent's own stream.
   *
   * The transcript belongs to the session on screen, while status, the bell,
   * and the queue stay with the agent this terminal drives. A live delta or a
   * failure folded into the wrong model would print one session's words as
   * another's, and the durable copy that follows would never correct it.
   */
  const agentListeners = (): readonly (() => void)[] => [
    ctx.on('agent/error', payload => {
      if (payload.agent.id !== viewedSession) return
      model.reportError(payload.error)
      ports.render()
    }),
    ctx.on('agent/assistant-stream', payload => {
      if (payload.agent.id !== viewedSession) return
      if (payload.frame.type !== 'chunk') return
      model.applyStreamChunk(payload.frame.chunk)
      ports.render()
    }),
  ]

  return {
    viewed: () => viewedSession,
    viewingChild: () => viewedSession !== ports.drivenSession(),
    notice: message => model.notice(message),
    marker: text => model.marker(text),
    reportError: error => model.reportError(error),
    model,
    workState: () => work.state(),
    sessionEvents,
    setPresentScope: scope => {
      presentScope = scope
    },
    clearPresentScope: () => {
      presentScope = undefined
    },
    reset,
    setViewed: id => {
      viewedSession = id
    },
    fold: foldHistory,
    replay: replayHistory,
    show: showSession,
    showDriven: showAgentSession,
    observe,
    agentListeners,
  }
}
