import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { forkPoint, type ForkEvent } from '../agent/fork.ts'
import { startAgent, type ForkInheritance, type TuiAgent } from '../agent/host.ts'
import type { HerdrReporter } from '../herdr/reporter.ts'
import { driverReportFor, sessionStartReason } from '../herdr/state.ts'
import { pendingPrompts } from '../queue.ts'
import { BELL, shouldRingBell } from '../terminal/bell.ts'
import { windowTitle } from '../terminal/title.ts'

/**
 * The agent this terminal drives: its identity, its activity, and every
 * transition that replaces it. One owner, because a replacement is one thing:
 * the handle, the turn it ran, the scope its cards read through, the transcript
 * folded from it, and its roster all move together.
 */

/** How often the running-state clock repaints while a turn is open. */
const STATUS_TICK_MS = 1000

/** The session this process runs, as much of it as a driven read needs. */
export interface LiveSession {
  /** The events this process holds unflushed, which storage alone does not. */
  readonly snapshotEvents?: () => readonly ForkEvent[]
}

/**
 * What the session's lifecycle owner needs from the surface that composes it.
 *
 * Every read is taken at call time: the session, the scrollback and the queue
 * all move while a transition settles, and a captured copy would name the
 * session this terminal drove before the reader moved.
 */
export interface SessionLifecyclePorts {
  /** The session this run was launched for; another is reached only by switching. */
  readonly initialSession: SessionId
  /** The route this run was launched with: the model, and the provider it names. */
  readonly model: string | undefined
  readonly provider: string | undefined
  /** Whether this run rings for a turn that ran long enough. */
  readonly bell: boolean
  /** The mode a session takes, settled before the transcript is touched. */
  readonly presetFor: (id: SessionId, resume: boolean, fork: ForkInheritance | undefined) => Promise<string | undefined>
  /** Install the session's own route; the world the preset mounts reads it back. */
  readonly installModelChoice: (agentCtx: Context) => void
  /** Mount the mode a new session runs into the agent's own scope. */
  readonly mountPreset: (agentCtx: Context, preset: string) => Promise<void>
  /** The live session this process runs, which is the only source holding the queue. */
  readonly liveSession: (id: SessionId) => LiveSession | undefined
  /** Re-arm the bar's completion against the world the new agent mounted. */
  readonly installCompletion: () => void
  /** Every event of a session, which a fork cut is derived from. */
  readonly sessionEvents: (id: SessionId) => Promise<readonly ForkEvent[]>
  /** Show a session without folding it; the open owns the fold that follows. */
  readonly setViewed: (id: SessionId) => void
  /** The scope a folded card reads its tool through. */
  readonly setPresentScope: (scope: Agent | undefined) => void
  /** Drop that scope; the outgoing agent is torn down after it. */
  readonly clearPresentScope: () => void
  readonly resetTranscript: () => void
  readonly replay: (id: SessionId) => Promise<void>
  readonly fold: (id: SessionId) => Promise<number>
  readonly notice: (message: string) => void
  readonly render: () => void
  /** The prompt memory's per-session reset, taken when a session is really opened. */
  readonly promptMemorySessionOpened: () => void
  /** The staged owner's fresh cursor for the session just opened. */
  readonly stagedSessionOpened: (id: SessionId) => void
  /** The turn/end an undo may be parked waiting for. */
  readonly turnSettled: () => void
  /** The parent's catalog names the child; lifecycle events carry only its id. */
  readonly acceptCatalog: (info: unknown) => void
  /** Drop the roster of the session a transition lets go of. */
  readonly resetRoster: () => void
  /** A job the turn started may have settled while the reader watched elsewhere. */
  readonly refreshJobs: () => void
  /** The pane's agent row, which hears the driver rather than each turn. */
  readonly herdr: HerdrReporter
  /** Write to the tty, but only while this surface owns it. */
  readonly writeTerminal: (text: string) => void
  /** Whether the exit has begun, which mutes the bell. */
  readonly exiting: () => boolean
  /** The surface's teardowns, in the order they are registered. */
  readonly disposers: Array<() => void>
}

/** The agent this terminal drives, and every read or operation the composer takes from it. */
export interface SessionLifecycle {
  /** The session this surface drives: commands, approvals, and the bell belong to it. */
  readonly activeSession: () => SessionId
  /** The agent in service, or undefined while a transition creates the next one. */
  readonly drivingAgent: () => TuiAgent | undefined
  /** Whether a turn is open, which the clock, the title and the bell read. */
  readonly turnRunning: () => boolean
  /** What the running-state clock reports: a turn, and when it started. */
  readonly activity: () => { readonly running: boolean; readonly startedAt: number | undefined }
  /** Whether a session was really opened, which is what an exit hint can name. */
  readonly sessionOpened: () => boolean
  /** The prompts queued on the driven agent, which an interrupt would drop. */
  readonly queuedPrompts: () => readonly string[]
  /** Stop the clock that repaints a running turn; an exit does not wait for it. */
  readonly stopClock: () => void
  /**
   * Stop the agent in service and let go of what it projected: the handle and its
   * projections go before the world they name is torn down, and the stop is
   * awaited so the next agent joins a surface nothing is still writing to.
   */
  readonly disposeOutgoing: () => Promise<void>
  /** Start the agent for a session, which is what a replacement joins. */
  readonly openAgent: (id: SessionId, resume: boolean, fork?: ForkInheritance) => Promise<TuiAgent>
  /** Move the surface to another stored session without leaving the terminal. */
  readonly switchSession: (id: SessionId) => Promise<void>
  /** Start a fresh session without leaving the terminal. */
  readonly runNewCommand: (title: string) => void
  /** Compose this session's agent again without leaving the conversation. */
  readonly runReloadCommand: () => void
  /**
   * Branch this conversation and continue in the branch: a real session that
   * inherits a prefix of this one, cut at the last completed turn because half an
   * exchange is not a state to hand a model.
   */
  readonly runForkCommand: (title: string) => void
  /** Give this session a title. */
  readonly runRenameCommand: (title: string) => void
  /** The driven half of one durable event; the caller folds the viewed half. */
  readonly observe: (session: { readonly id: SessionId }, event: ForkEvent) => void
  /** The listeners that follow the driver rather than each turn. */
  readonly driverListeners: () => readonly (() => void)[]
}

export function createSessionLifecycle(ctx: Context, ports: SessionLifecyclePorts): SessionLifecycle {
  /** The session this surface drives: commands, approvals, and the bell belong to it. */
  let activeSession = ports.initialSession
  /** The agent in service, or undefined while a transition creates the next one. */
  let agent: TuiAgent | undefined
  /** Whether a turn is open, which is what the clock repaints for. */
  let turnOpen = false
  /** When the open turn started, which the status facts time it from. */
  let turnStartedAt: number | undefined
  /** Whether a session was really opened, which is what an exit hint can name. */
  let sessionOpened = false

  // The queue is read from the agent this terminal drives rather than from the
  // session on screen, because it sits on the editor that submits to that agent.
  const queuedPrompts = (): readonly string[] => pendingPrompts(ctx, ports.liveSession(activeSession))

  // Only a running turn has anything to say over time, so the clock stops with it.
  const statusTicker: ReturnType<typeof setInterval> = setInterval(() => {
    if (turnOpen) ports.render()
  }, STATUS_TICK_MS)
  ports.disposers.push(() => clearInterval(statusTicker))

  const stopClock = (): void => clearInterval(statusTicker)

  /**
   * Let go of the agent in service and everything projected from it, handing the
   * handle back to be stopped.
   *
   * `clearScope` is the path's, not this helper's: a replacement drops the
   * outgoing scope before stopping its agent, and an open that folds history of
   * its own relies on the scope it installs.
   */
  const letGoOfOutgoing = (clearScope: boolean): TuiAgent | undefined => {
    const previous = agent
    agent = undefined
    turnOpen = false
    // The outgoing turn's clock dies with its agent; leaving it set would time
    // the session being joined by work it never ran.
    turnStartedAt = undefined
    if (clearScope) ports.clearPresentScope()
    ports.resetTranscript()
    ports.resetRoster()
    return previous
  }

  const disposeOutgoing = async (): Promise<void> => {
    const previous = letGoOfOutgoing(true)
    if (previous !== undefined) await previous.dispose()
  }

  const openAgent = async (id: SessionId, resume: boolean, fork?: ForkInheritance): Promise<TuiAgent> => {
    // Settled before the transcript is touched, so a refusal leaves neither a
    // half-replayed session nor a half-composed agent behind.
    const preset = await ports.presetFor(id, resume, fork)
    const handle = await startAgent(ctx, {
      sessionId: id,
      resume,
      model: ports.model,
      provider: ports.provider,
      cwd: process.cwd(),
      preset,
      setup: async agentCtx => {
        ports.installModelChoice(agentCtx)
        if (preset !== undefined) await ports.mountPreset(agentCtx, preset)
      },
      ...(fork === undefined ? {} : { fork }),
    })
    sessionOpened = true
    activeSession = id
    ports.setViewed(id)
    agent = handle
    // A resumed agent can already own live jobs, so the pane must know about
    // them before its driver's phase is reported as idle.
    ports.refreshJobs()
    // A cursor counts the turns of one log; the session just opened has its own.
    ports.stagedSessionOpened(id)
    ports.promptMemorySessionOpened()
    // agent/status is emitted on transitions only, so a driver that was
    // already running when this surface attached — a resume that wakes
    // straight away — would otherwise stay unreported until it stops. The
    // status is read once here and settled before the session identity, so the
    // report that carries the new session id states the driver's real phase
    // rather than the one the previous session left behind.
    ports.herdr.driver(handle.agent.status)
    // The agent's own id is reported rather than the requested one: a resume can
    // be answered by the session the log actually holds.
    ports.herdr.session({
      id: String(handle.sessionId),
      cwd: process.cwd(),
      reason: sessionStartReason({ forked: fork !== undefined, resumed: resume }),
    })
    // A session with no history to fold still has to present its first live
    // card through the right scope, so the scope is set before any event can.
    ports.setPresentScope(handle.agent)
    // Replayed only once the agent exists, because the fold reads every card
    // through the scope the preset mounted; a fold before that scope existed
    // degraded each replayed card to a bare generic row. The agent's loop is
    // live by now, so the fold and the stream race over the same events; the
    // durable sequence number is what keeps one event from landing twice.
    if (resume) await ports.replay(id)
    // A branch inherits the conversation the reader was already reading, so it
    // opens on that history rather than on an empty screen.
    if (fork !== undefined) await ports.fold(id)
    ports.disposers.push(() => {
      void handle.dispose()
    })
    ports.installCompletion()
    ports.notice(`session ${handle.sessionId}${resume ? ' (resumed)' : ''}`)
    ports.render()
    // Returned so a caller that replaced the handle can send through the new
    // one without a fresh read of state TypeScript can no longer widen.
    return handle
  }

  const switchSession = async (id: SessionId): Promise<void> => {
    await disposeOutgoing()
    await openAgent(id, true)
  }

  const runNewCommand = (title: string): void => {
    if (agent === undefined) {
      ports.notice('the agent is still starting; try again in a moment')
      ports.render()
      return
    }
    void (async () => {
      const previous = letGoOfOutgoing(false)
      if (previous !== undefined) await previous.dispose()
      await openAgent(SessionId(`tui-session-${randomUUID()}`), false)
      if (title !== '') runRenameCommand(title)
      ports.notice('started a new session')
      ports.render()
    })().catch((error: unknown) => {
      ports.notice(`could not start a session: ${error instanceof Error ? error.message : String(error)}`)
      ports.render()
    })
  }

  /**
   * Compose this session's agent again without leaving the conversation: a
   * preset's standing mount only re-reads its composition file for an agent that
   * joins after the file changed, and the durable log is replayed afterwards, so
   * the reader keeps the conversation they were reading.
   */
  const runReloadCommand = (): void => {
    // A failed reload leaves no agent behind, so the command has to be usable
    // again: the retry is what makes a broken composition file recoverable,
    // while a surface that has opened no session yet is still starting.
    if (agent === undefined && !sessionOpened) {
      ports.notice('the agent is still starting; try again in a moment')
      ports.render()
      return
    }
    const queued = queuedPrompts()
    // Work the reader would lose is a decision, and the interrupt key already
    // owns that decision: it stops the turn and hands queued words back to the
    // bar. Reopening the session drops the inbox, so a reload that would take
    // those words asks for the key instead of asking a question of its own.
    if (turnOpen || queued.length > 0) {
      ports.notice(
        queued.length > 0
          ? `${queued.length} queued ${queued.length === 1 ? 'prompt' : 'prompts'} would be dropped — ctrl+c hands them back to the bar, then /reload`
          : 'a turn is running — ctrl+c interrupts it first (delivered text is kept), then /reload',
      )
      ports.render()
      return
    }
    const id = activeSession
    void (async () => {
      // The same transition a session switch takes, aimed at the session
      // already open: dispose, then join its preset generation anew.
      await switchSession(id)
      ports.notice("reloaded this session's composition; the transcript was replayed")
      ports.render()
    })().catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error)
      ports.notice(`could not reload: ${reason} — fix the composition and /reload again`)
      ports.render()
    })
  }

  const runForkCommand = (title: string): void => {
    if (agent === undefined) {
      ports.notice('the agent is still starting; try again in a moment')
      ports.render()
      return
    }
    void (async () => {
      const source = activeSession
      const events = await ports.sessionEvents(source)
      const point = forkPoint(events)
      if (point === undefined) {
        ports.notice('nothing to fork yet: this session has no completed turn')
        ports.render()
        return
      }
      const childId = SessionId(`tui-session-${randomUUID()}`)
      const previous = letGoOfOutgoing(false)
      if (previous !== undefined) await previous.dispose()
      await openAgent(childId, false, { from: source, events: events.slice(0, point.inheritedEvents) })
      if (title !== '') runRenameCommand(title)
      ports.notice(`forked from ${source} at event ${point.boundarySeq} — ${point.inheritedEvents} inherited`)
      ports.render()
    })().catch((error: unknown) => {
      ports.notice(`could not fork: ${error instanceof Error ? error.message : String(error)}`)
      ports.render()
    })
  }

  /**
   * Give this session a title: it is what the resume picker shows, so a reader
   * who has several sessions can name the one they are in.
   */
  const runRenameCommand = (title: string): void => {
    if (title === '') {
      ports.notice('use /rename <title>; the title is what the resume picker shows')
      ports.render()
      return
    }
    const session = (ctx.get('sessions') as { get?: (id: SessionId) => unknown } | undefined)?.get?.(activeSession)
    const titles = ctx.get('sessionTitle') as { rename?: (session: unknown, title: string) => { readonly title?: string } } | undefined
    if (session === undefined || typeof titles?.rename !== 'function') {
      ports.notice('this profile has no session-title service, so this session cannot be renamed')
      ports.render()
      return
    }
    try {
      const accepted = titles.rename(session, title)
      ports.notice(`session renamed to "${typeof accepted?.title === 'string' ? accepted.title : title}"`)
    } catch (error) {
      ports.notice(`could not rename: ${error instanceof Error ? error.message : String(error)}`)
    }
    ports.render()
  }

  /**
   * The driven half of one durable event.
   *
   * The surface state — activity, timer, title, bell, job board — belongs to the
   * agent this terminal drives, even while a child is on screen.
   */
  const observe = (session: { readonly id: SessionId }, event: ForkEvent): void => {
    if (session.id !== activeSession) return
    // The parent's catalog names the child; lifecycle events carry only its id.
    if ((event as { type: string }).type === 'subagent/catalog') {
      ports.acceptCatalog(event.data)
      ports.render()
    }
    if (event.type === 'turn/start') {
      turnOpen = true
      turnStartedAt = Date.now()
      ports.writeTerminal(windowTitle(process.cwd(), 'working'))
    }
    if (event.type === 'turn/end') {
      const ranFor = turnStartedAt === undefined ? 0 : Date.now() - turnStartedAt
      turnOpen = false
      turnStartedAt = undefined
      // An undo may be parked waiting for exactly this boundary.
      ports.turnSettled()
      ports.writeTerminal(windowTitle(process.cwd(), 'ready'))
      if (shouldRingBell({ bell: ports.bell, ranForMs: ranFor, exiting: ports.exiting() })) ports.writeTerminal(BELL)
      // A job the turn started may have settled while the reader was watching
      // something else, and nothing else refreshes a live board.
      ports.refreshJobs()
    }
    // A claim or a discard changes what is queued, and that belongs to this
    // session even while the transcript shows a child's conversation.
    if (event.type === 'agent/inbox/spliced') ports.render()
  }

  /** The name is cast so a rename in the harness cannot break this compilation. */
  const listenFor = (name: string, handler: (...args: readonly unknown[]) => void): (() => void) =>
    (ctx.on as unknown as (event: string, listener: (...args: readonly unknown[]) => void) => () => void)(name, handler)

  /**
   * The listeners that follow the driver rather than each turn: a run chaining
   * turns through a pending inbox is one stretch of work, and a turn boundary
   * inside it would read as done while the agent is still working; the turn
   * events keep the title and the bell, the reader's own conversation.
   */
  const driverListeners = (): readonly (() => void)[] => [
    listenFor('agent/status', payload => {
      // Read against the driven session at delivery time: the reader can switch
      // sessions between two transitions, and the row must follow the one this
      // terminal now drives.
      const status = driverReportFor(payload, activeSession)
      if (status === undefined) return
      ports.herdr.driver(status)
    }),
  ]

  return {
    activeSession: () => activeSession,
    drivingAgent: () => agent,
    turnRunning: () => turnOpen,
    activity: () => ({ running: turnOpen, startedAt: turnStartedAt }),
    sessionOpened: () => sessionOpened,
    queuedPrompts,
    stopClock,
    disposeOutgoing,
    openAgent,
    switchSession,
    runNewCommand,
    runReloadCommand,
    runForkCommand,
    runRenameCommand,
    observe,
    driverListeners,
  }
}
