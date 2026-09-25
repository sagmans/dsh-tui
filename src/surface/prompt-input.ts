import {
  isKeyRelease,
  matchesKey,
  type CombinedAutocompleteProvider,
  type KeyId,
} from '@earendil-works/pi-tui'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Type-only: the command registry publishes the change event this surface
// listens to, and the event map is declaration-merged by that package.
import type {} from '@deepseek-ai/dsh-commands'
import { surfaceBindings, type Keymap } from '../input/actions.ts'
import type { SurfaceActionId } from '../input/action-catalog.ts'
import { cancelStep, quitStep } from '../input/cancel.ts'
import { createAnswerCompletionProvider, createCompletionProvider, type RegisteredCommand } from '../input/completion.ts'
import { createFileIndex } from '../input/file-index.ts'
import { ChordReader, chordBindings, installKeybindings } from '../input/keymap.ts'
import { classifySubmission, type Submission } from '../input/submission.ts'
import type { WarningSafeTui } from '../terminal/warning-screen.ts'
import type { GateInputBar } from '../ui/gate-input.ts'
import type { PromptBar } from '../ui/prompt.ts'

/**
 * What the prompt-input owner needs from the surface that composes it.
 *
 * Every read is taken at call time. The keys, their prefix and the chord window
 * belong to the settings document, which is hot-reloaded, so a copy kept here
 * would answer the reader's next press with the map of the day this loaded. The
 * terminal and the bar are reached through readers for the opposite reason: the
 * settings scope applies before either exists, and the chord it has to end is
 * armed at that moment.
 */
export interface PromptInputPorts {
  /** The keys in force; the settings document owns them and the surface holds them. */
  readonly keymap: () => Keymap
  /** The keys that start a chord, and how long one waits; the settings document owns all of it. */
  readonly prefixKeys: () => readonly KeyId[]
  readonly prefixWindowMs: () => number
  readonly tui: () => WarningSafeTui
  /** The bar the reader types in, and the question that borrows it. */
  readonly editor: () => GateInputBar
  readonly promptBar: () => PromptBar
  /** Drive an open gate or picker; false hands the press back. */
  readonly modalHandleKey: (data: string) => boolean
  /** Flip one of the folds the transcript is drawn with. */
  readonly toggleCards: () => void
  readonly toggleSubCalls: () => void
  readonly toggleReasoning: () => void
  readonly openEffortPicker: () => void
  readonly openHistoryPicker: () => void
  /** Return to this session's own transcript, when a child is on screen. */
  readonly back: () => void
  /** What the agent has not started yet, which one press takes back. */
  readonly queuedPrompts: () => readonly string[]
  readonly turnRunning: () => boolean
  readonly viewingChild: () => boolean
  readonly interrupt: () => void
  readonly notice: (message: string) => void
  readonly requestExit: (code: number) => void
  /** Remember one submitted line; the prompt's own memory owns the store. */
  readonly recordPrompt: (text: string) => void
  /** Carry out one classified line; the command routing owner takes it over later. */
  readonly runSubmission: (submission: Submission) => void
  /** The agent this terminal drives, or undefined while it starts. */
  readonly drivenAgent: () => Agent | undefined
  /**
   * The commands that agent can run, or undefined when no registry answers.
   *
   * A scoped list operation rather than the registry itself: the registry is
   * read through its own owner, and this one only ever needs what is offered.
   */
  readonly registeredCommands: (agent: Agent) => readonly RegisteredCommand[] | undefined
}

/** The presses, menus and the submit line the composing surface routes here. */
export interface PromptInput {
  /**
   * Install the reader's keys where the library reads them.
   *
   * Installed where the library reads it, so a remap lands on the next press
   * rather than at the next restart.
   */
  readonly installBindings: () => void
  /** A chord armed under the keymap the reader just replaced is not their chord. */
  readonly disarmChord: () => void
  /** The armed chord as the footer prints it, or undefined when nothing is armed. */
  readonly chordHint: () => string | undefined
  /** Register this owner's press listener; the answer takes it back off. */
  readonly inputListener: () => () => void
  /** Give the bar the menu the role it is in calls for. */
  readonly applyCompletion: () => void
  /** Rebuild both menus from whatever this session can run right now. */
  readonly installCompletion: () => void
  /** Register the rebuild a newly registered command asks for. */
  readonly commandListeners: () => readonly (() => void)[]
  /** Classify a submitted line, remember it, and hand it to the surface. */
  readonly attachSubmit: () => void
}

/**
 * The prompt bar's own presses: the chord, the keys the surface answers itself,
 * and the line it submits.
 *
 * A press reaches the surface's listener before any focused component sees it,
 * so everything that answers a key held at the bar is decided in one place:
 * what a chord may finish, which keys are consumed outright, and where a
 * submitted line goes. The two completion menus share the same seam because
 * they follow the bar's role rather than a session, and the command registry
 * that fills one of them is read live.
 */
export function createPromptInput(ctx: Context, ports: PromptInputPorts): PromptInput {
  /**
   * The chord between a prefix and the action that follows it.
   *
   * Built before the terminal exists, because the settings scope applies first
   * and has to be able to end a chord armed under the keymap it replaced. The
   * repaint the window also wants is late-bound: only a key press reaches it,
   * and no key can arrive before the surface has started.
   */
  const keyChord = new ChordReader(
    () => ports.prefixKeys(),
    () => chordBindings(ports.keymap()),
    () => ports.prefixWindowMs(),
    () => ports.tui().requestRender(),
  )

  /**
   * Whether the bar holds anything the reader wrote.
   *
   * Whitespace counts: it is a character the editor holds, and a press that
   * clears it is the press the reader asked for. A paste counts expanded,
   * because a marker is content rather than an absence of it.
   */
  const barHasText = (): boolean => ports.editor().getExpandedText() !== ''

  /**
   * What each key the surface answers itself does; false hands the press back.
   *
   * Keyed by the table's own ids, so a key added to {@link SURFACE_ACTIONS}
   * without a handler here fails to compile rather than doing nothing.
   */
  const surfaceActions: Readonly<Record<SurfaceActionId, () => boolean>> = {
    toolDetail: () => {
      ports.toggleCards()
      ports.tui().requestRender()
      return true
    },
    subCalls: () => {
      ports.toggleSubCalls()
      ports.tui().requestRender()
      return true
    },
    reasoning: () => {
      ports.toggleReasoning()
      ports.tui().requestRender()
      return true
    },
    effort: () => {
      ports.openEffortPicker()
      return true
    },
    history: () => {
      ports.openHistoryPicker()
      return true
    },
    back: () => {
      ports.back()
      return true
    },
    interrupt: () => {
      // In raw mode Ctrl+C never reaches the process as SIGINT, so the surface
      // decides what one press takes back — and a press with nothing left to
      // cancel is handed back rather than spent on leaving.
      const queued = ports.queuedPrompts()
      const step = cancelStep({
        barHasText: barHasText(),
        queuedPrompts: queued.length,
        turnRunning: ports.turnRunning(),
        viewingChild: ports.viewingChild(),
      })
      switch (step) {
        case 'clear-editor':
          ports.editor().setText('')
          ports.tui().requestRender()
          return true
        case 'reclaim-queued':
          // The interrupt drops whatever the agent had not started, so the words
          // are read before it is stopped and handed back to the bar: a key that
          // means "stop" must not be the key that loses the reader's own prompts.
          ports.interrupt()
          ports.editor().setText(queued.join('\n'))
          ports.notice(`interrupt requested · ${queued.length} queued ${queued.length === 1 ? 'prompt' : 'prompts'} back in the bar`)
          ports.tui().requestRender()
          return true
        case 'interrupt-turn':
          ports.interrupt()
          ports.notice('interrupt requested')
          ports.tui().requestRender()
          return true
        case 'leave-child-view':
          ports.back()
          return true
        case 'hand-back':
          return false
      }
    },
    quit: () => {
      // The only key that leaves. Text in the bar keeps it for the editor, so
      // the library's delete forward is never taken from a reader who is editing.
      switch (quitStep({ barHasText: barHasText(), overlayOpen: ports.tui().hasOverlay(), turnRunning: ports.turnRunning() })) {
        case 'cancel-then-quit':
          // An exit that waits on a tool call is not an exit, so the turn is
          // asked to stop and the leave does not wait for the answer.
          ports.interrupt()
          ports.requestExit(0)
          return true
        case 'quit':
          ports.requestExit(0)
          return true
        case 'hand-back':
          return false
      }
    },
  }

  /** One scan of the workspace, shared by both menus: the listing is read-only and cached. */
  const fileIndex = createFileIndex(process.cwd())
  /** The menu the prompt bar offers: the commands this session can run, and the workspace's files. */
  let promptCompletion: CombinedAutocompleteProvider | undefined
  /** The menu an answer offers, which is the same menu without the commands. */
  let answerCompletion: CombinedAutocompleteProvider | undefined

  /**
   * Give the bar the menu its current role calls for.
   *
   * A question borrows the prompt bar's editor rather than drawing its own, so
   * the provider has to follow the borrow: a slash command is a line this
   * surface would run, and an answer is text the model reads, so the two roles
   * must not share one menu.
   */
  const applyCompletion = (): void => {
    const chosen = ports.promptBar().isBorrowed() ? answerCompletion : promptCompletion
    if (chosen !== undefined) ports.editor().setAutocompleteProvider(chosen)
  }

  /**
   * Offer completion for whatever this session can run right now.
   *
   * The registry is agent-scoped and still empty while the agent starts, so the
   * menu is rebuilt when the agent arrives and whenever a package registers
   * another command. Both providers are built here because the answer's is the
   * prompt bar's own minus the commands, and a rebuild while a question is open
   * must not leave the answer menu unreachable.
   */
  const installCompletion = (): void => {
    const current = ports.drivenAgent()
    if (current === undefined) return
    const commands = ports.registeredCommands(current)
    if (commands === undefined) return
    answerCompletion = createAnswerCompletionProvider(process.cwd(), fileIndex)
    promptCompletion = createCompletionProvider(commands, process.cwd(), fileIndex)
    applyCompletion()
  }

  return {
    installBindings: () => installKeybindings(ports.keymap()),
    disarmChord: () => keyChord.disarm(),
    chordHint: () => keyChord.hint(),
    applyCompletion,
    installCompletion,
    commandListeners: () => [ctx.on('commands/change', () => installCompletion())],
    inputListener: () => ports.tui().addInputListener(data => {
      // A key arrives as a press and a release once the surface asks the terminal
      // to report key events, and this library drops the release only for the
      // focused component: a listener sees both halves, so an arrow key that is
      // acted on twice steps a picker two rows and answers a question two options
      // on. Falls through rather than consuming, which leaves a component that
      // asked for releases its own half.
      if (isKeyRelease(data)) return undefined
      if (ports.modalHandleKey(data)) return { consume: true }
      // A chord is the surface's second key: the prefix is consumed and the
      // footer names what may follow, while a key that finishes nothing is handed
      // on. Detail the reader asked for is always available, even mid-turn: the
      // collapsed view is a default, not the only state.
      const chorded = keyChord.handle(data)
      if (chorded !== undefined) {
        if (chorded.kind === 'action') ports.runSubmission(chorded.binding.submission)
        ports.tui().requestRender()
        return { consume: true }
      }
      for (const binding of surfaceBindings(ports.keymap())) {
        if (!matchesKey(data, binding.key)) continue
        return surfaceActions[binding.action]() ? { consume: true } : undefined
      }
      return undefined
    }),
    attachSubmit: () => {
      ports.editor().onSubmit = text => {
        const submission = classifySubmission(text)
        if (submission.kind === 'empty') return
        // The library's own history feeds the up/down keys; the store below feeds
        // ghost completion and reverse search, and is global rather than per-session.
        ports.editor().addToHistory(text)
        ports.recordPrompt(text)
        ports.runSubmission(submission)
      }
    },
  }
}
