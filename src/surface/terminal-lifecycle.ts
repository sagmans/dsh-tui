import { ProcessTerminal } from '@earendil-works/pi-tui'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TuiAgent } from '../agent/host.ts'
import { createHerdrReporter, type HerdrReporter } from '../herdr/reporter.ts'
import { PROFILE_NAME, resumeHint } from '../identity.ts'
import { clipboardSequence } from '../terminal/clipboard.ts'
import { ExternalEditor } from '../terminal/external-editor.ts'
import { createRestoreRegistry } from '../terminal/restore.ts'
import { installSignalRestore } from '../terminal/signals.ts'
import { CLEAR_TITLE, windowTitle } from '../terminal/title.ts'
import { WarningSafeTui } from '../terminal/warning-screen.ts'
import { cleanCopied } from '../ui/copy.ts'
import type { FrameRow } from '../ui/frame.ts'

/**
 * What the terminal's owner needs from the surface that composes it.
 *
 * Every read is taken at call time: a handoff, an exit, or a copied selection
 * happens against whatever this terminal drives when it happens, and a captured
 * copy would name the session the surface happened to open first.
 */
export interface TerminalLifecyclePorts {
  /** A frame that could not be drawn reaches the transcript through here. */
  readonly reportFrameError: (error: unknown) => void
  /** Say something the screen cannot: a failed handoff is one. */
  readonly notice: (message: string) => void
  /** The rows the last frame drew, which is what a copied selection is read through. */
  readonly copyRows: () => readonly FrameRow[]
  /** The session this terminal drives, which is what an exit hint can offer back. */
  readonly activeSession: () => SessionId
  /** Whether a session was really opened; a run that opened none has nothing to point at. */
  readonly sessionOpened: () => boolean
  /** Whether a turn is open, which the title names once the screen comes back. */
  readonly turnRunning: () => boolean
  /** Stop the clock that repaints a running turn; an exit does not wait for it. */
  readonly stopClock: () => void
  /** Leave the process with the status the caller owns. */
  readonly exit: (code: number) => void
  /** The draft the bar holds, which is what the reader's own editor is handed. */
  readonly draftText: () => string
  /** Whether a question borrowed the bar, so an edited draft must wait behind it. */
  readonly draftBorrowed: () => boolean
  /** Park an edited draft behind a borrowed bar instead of answering the question. */
  readonly holdDraft: (text: string) => void
  /** Put an edited draft back into the bar. */
  readonly writeDraft: (text: string) => void
  /**
   * Let go of the agent in service and everything projected from it, handing the
   * handle back to be stopped.
   *
   * The handle, the turn it ran, the scope its cards read through, the transcript
   * folded from it, and its background roster are the composer's own state, so
   * this owner asks for the handle rather than writing any of it.
   */
  readonly takeOutgoingAgent: () => TuiAgent | undefined
}

/** The handles and operations the composing surface routes to this owner. */
export interface TerminalLifecycle {
  readonly terminal: ProcessTerminal
  readonly tui: WarningSafeTui
  /** The pane's agent row; the surface reports through it and this owner releases it. */
  readonly herdr: HerdrReporter
  /**
   * The surface's teardowns, in the order they were registered.
   *
   * The array is handed out rather than wrapped in a register function because
   * the composing surface registers most of them, several by spreading a
   * listener list: one array is what keeps a spread and a single push in the
   * same order, and the unwind below reverses that one order.
   */
  readonly disposers: Array<() => void>
  /** Write to the tty, but only while this surface owns it. */
  readonly writeTerminal: (text: string) => void
  readonly handedOver: () => boolean
  readonly disposed: () => boolean
  readonly exited: () => boolean
  readonly requestExit: (code: number, reason?: string) => void
  /**
   * Stop the agent in service and let go of what it projected.
   *
   * Every replacement of the agent this terminal drives — a staged send, a
   * session switch, a reload, a new session, a fork — has to let the outgoing one
   * go the same way, and in this order: the handle and its projections go before
   * the world they name is torn down, and the stop is awaited so the next agent
   * joins a surface nothing of the previous one is still writing to.
   */
  readonly disposeOutgoing: () => Promise<void>
  /** Hand the draft to the reader's own editor and take back what it saved. */
  readonly editDraft: () => void
}

/**
 * The terminal's lifetime: the screen this surface owns, the way out of it, and
 * the child that borrows it.
 *
 * Ownership is the whole subject: the alternate screen, the hooks that put the
 * shell back, and the exit are one mechanism, and a second writer would not
 * know that the reader's own editor holds the tty. The composer keeps the
 * widgets; this owner keeps every byte written to the terminal.
 */
export function createTerminalLifecycle(ctx: Context, ports: TerminalLifecyclePorts): TerminalLifecycle {
  const restore = createRestoreRegistry()
  const terminal = new ProcessTerminal()
  const tui = new WarningSafeTui(terminal, { copySelection })
  // A frame that cannot be drawn leaves the last good screen up, so the failure
  // has to reach the transcript: otherwise the surface looks frozen and nothing
  // on screen can say why.
  tui.onFrameError = error => ports.reportFrameError(error)
  /** Whether a child process owns the terminal, which is when nothing here may write to it. */
  let handedOver = false
  /** Whether the host has unloaded this surface, after which nothing may start it again. */
  let disposed = false
  /** An exit asked for while a child owned the terminal, run once the screen is ours again. */
  let deferredExit: { readonly code: number; readonly reason: string | undefined } | undefined
  /** Whether the exit has begun, which is when nothing may start another. */
  let exited = false
  /**
   * Write to the tty, but only while this surface owns it.
   *
   * An editor the reader opened draws its own screen on the same terminal, so a
   * title or a bell from here would land on top of it and, for a bell, sound as
   * if the editor had failed. The title is written again when the screen comes
   * back; a bell that fell in the gap is dropped rather than rung late.
   */
  const writeTerminal = (text: string): void => {
    if (!handedOver) terminal.write(text)
  }

  /**
   * Put a copied selection on the clipboard as the words it selected.
   *
   * A terminal copies the screen, so a drag across a message takes the box the
   * message was drawn in along with it. The rows the last frame drew are the
   * account of that frame, so the copy is read back through them: the shape the
   * surface added comes off, and nothing the reader wrote does.
   */
  function copySelection(text: string): Promise<boolean> {
    if (handedOver) return Promise.resolve(false)
    terminal.write(clipboardSequence(cleanCopied(text, ports.copyRows())))
    return Promise.resolve(true)
  }

  const disposers: Array<() => void> = []

  // A containing Herdr is told what this pane is doing; away from one the
  // reporter is inert, so the surface never depends on being multiplexed.
  const herdr = createHerdrReporter()
  // Kept out of the disposal list on purpose: the row is handed back before
  // this stops guarding it, so a host that leaves during the release still
  // releases synchronously.
  const unregisterExit = herdr.registerExitRelease()

  restore.add(() => tui.stop())
  ctx.effect(() => () => {
    // A surface the host unloads owns no screen and keeps no listeners, so a
    // child still running in another process must not be handed a start().
    disposed = true
    // The pane stops being an agent before the process that claimed it unwinds:
    // a release that ran after the reports were unregistered would race them,
    // and one that never ran would leave a row that reads as a live agent. The
    // reports already on the wire are settled first, because Herdr ignores a
    // release for a pane nothing has claimed yet — the report that followed it
    // would otherwise claim the row back. The promise is returned so a host that
    // waits for teardown waits for the row too, and the exit listener outlives
    // the wait, so one that does not still hands the row back synchronously.
    const released = herdr.release().catch(() => undefined)
    restore.restore()
    for (const dispose of disposers.reverse()) dispose()
    return released.finally(unregisterExit)
  })

  const disposeOutgoing = async (): Promise<void> => {
    const previous = ports.takeOutgoingAgent()
    if (previous !== undefined) await previous.dispose()
  }

  const requestExit = (code: number, reason?: string): void => {
    if (exited) return
    // A child owns the terminal: restoring it here would leave the reader a
    // shell behind an editor that is still running, and would put its tty back
    // into cooked mode under it. The exit waits for the screen to come back.
    if (handedOver) {
      deferredExit = { code, reason }
      return
    }
    exited = true
    ports.stopClock()
    // The screen goes back at once, so leaving feels like leaving; the row goes
    // back behind it. Reports already on the wire are settled first, because
    // Herdr ignores the release of a pane nothing has claimed yet — the report
    // that followed it would otherwise claim the row back during shutdown.
    terminal.write(CLEAR_TITLE)
    restore.restore()
    void herdr
      .release()
      // Nobody is left to report a release that failed on the way out, and a
      // row that could not be cleared is not a reason to keep the process.
      .catch(() => undefined)
      .finally(() => {
        // Everything below is written after the release: a failure nobody can
        // read is not a failure that was reported.
        if (reason !== undefined) terminal.write(`\ndsh-tui: ${reason}\n`)
        // The hint is computed here rather than read from the context because
        // only the surface knows which session it is leaving: a fork or a
        // switch moves it. A run that opened nothing has nothing to offer back:
        // the identity it was launched with names no log, so pointing at it
        // would send the reader to a conversation that does not exist.
        if (ports.sessionOpened()) terminal.write(`\n${resumeHint(String(ports.activeSession()), PROFILE_NAME)}\n`)
        ports.exit(code)
      })
  }

  // A signal ends the process from outside the surface, and the default action
  // would leave the reader on a screen no shell prompt is drawn in: the same
  // shutdown a quit key runs goes to the signals a supervisor sends.
  disposers.push(installSignalRestore({ shutdown: code => requestExit(code, 'interrupted') }))

  /**
   * The reader's own editor, opened over the draft the bar holds.
   *
   * The screen is handed over rather than drawn beside: an editor needs the
   * terminal, so this is the one moment the surface is not the process painting
   * on it. Every failure is reported as a notice and leaves the bar as it was,
   * because the caller is a key press with nowhere to put an error.
   */
  const externalEditor = new ExternalEditor({
    suspend: () => {
      handedOver = true
      try {
        // The frame is left in place rather than repainted into the normal
        // buffer: the editor is about to paint over that same screen.
        tui.stop({ preserveScreen: true })
      } catch (error) {
        // A stop that failed leaves the screen ours; leaving the flag up would
        // suppress every later title and defer every exit for good.
        handedOver = false
        throw error
      }
    },
    resume: () => {
      // Whatever the host unloaded is not coming back: starting it again would
      // paint on a terminal this process is done with, into listeners that are gone.
      if (disposed) return
      try {
        tui.start()
      } finally {
        handedOver = false
      }
      // Entering the alternate screen clears it, and any render asked for while
      // the child owned the terminal was dropped after setting the very flag that
      // makes the next ordinary request a no-op: without a forced one the reader
      // would get a blank screen with a working keyboard under it.
      tui.requestRender(true)
      // The title is state this surface owns and the handoff swallowed any change
      // to it, so a turn that ended while the editor was open would leave
      // "working" up until the next turn.
      writeTerminal(windowTitle(process.cwd(), ports.turnRunning() ? 'working' : 'ready'))
    },
    notice: message => ports.notice(message),
  })

  /**
   * Hand the draft to the reader's editor and take back whatever it saved.
   *
   * An exit that was asked for during the handoff runs here rather than in the
   * key that asked: the child owned the screen then, and the screen is this
   * surface's again only once the editor has returned.
   *
   * A gate can open while the child owns the screen, and the bar then holds
   * somebody's answer: the edited draft waits behind it instead of being written
   * into a question the reader never answered.
   */
  const editDraft = (): void => {
    void externalEditor.edit(ports.draftText()).then(text => {
      if (text !== undefined) {
        if (ports.draftBorrowed()) ports.holdDraft(text)
        else ports.writeDraft(text)
        tui.requestRender()
      }
      const pendingExit = deferredExit
      deferredExit = undefined
      if (pendingExit !== undefined) requestExit(pendingExit.code, pendingExit.reason)
    })
  }

  return {
    terminal,
    tui,
    herdr,
    disposers,
    writeTerminal,
    handedOver: () => handedOver,
    disposed: () => disposed,
    exited: () => exited,
    requestExit,
    disposeOutgoing,
    editDraft,
  }
}
