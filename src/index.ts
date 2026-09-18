import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ProcessTerminal, ScrollView, VStack, isKeyRelease, matchesKey } from '@earendil-works/pi-tui'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Type-only: the command registry publishes the change event this surface
// listens to, and the event map is declaration-merged by that package.
import type {} from '@deepseek-ai/dsh-commands'
import { startAgent, type ForkInheritance, type TuiAgent } from './agent/host.ts'
import {
  PICKER_LIMIT,
  createSessionHistory,
  presetOfStoredSession,
  readSessionTitle,
  type SessionHistory,
  type StoredSession,
} from './agent/history.ts'
import { createPresetRoster, parsePresetArgument, type PresetRoster, type PresetSummary } from './agent/presets.ts'
import { createToolPresenter } from './agent/present.ts'
import { forkPoint, type ForkEvent } from './agent/fork.ts'
import { PROFILE_NAME, resumeHint } from './identity.ts'
import { createStatusFacts } from './agent/status.ts'
import { ModelSwitch, createModelCatalog, parseModelArgument } from './agent/model.ts'
import { JOB_READ_LINES, createJobDirectory, describeJobs, parseJobsArgument, type JobSummary } from './jobs.ts'
import {
  SubagentRoster,
  createSubagentControl,
  describeSubagents,
  parseSubagentsArgument,
  resolveRun,
} from './subagents.ts'
import { describeMissingOptional, describeMissingRequired, probeComposition } from './compat/probe.ts'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import { ApprovalGate, QuestionGate, toGateQuestions, type GateAnswer } from './gates.ts'
import { createCompletionProvider } from './input/completion.ts'
import { LOCAL_COMMANDS, classifySubmission } from './input/submission.ts'
import { resolveConfig } from './config.ts'
import { FoldCursor } from './fold-cursor.ts'
import { createRestoreRegistry } from './terminal/restore.ts'
import { WarningSafeTui } from './terminal/warning-screen.ts'
import { BELL, shouldRingBell } from './terminal/bell.ts'
import { clipboardSequence } from './terminal/clipboard.ts'
import { CLEAR_TITLE, windowTitle } from './terminal/title.ts'
import { defaultExportFile, transcriptToText } from './export.ts'
import { createTheme, forwardEditorTheme, forwardMarkdownTheme, type TuiTheme } from './theme.ts'
import { detectColourMode, type ColourMode } from './theme-capability.ts'
import { defaultSettings, readScope, toOverrides, TUI_SETTINGS_NAMESPACE, TuiSettingsSchema, type TuiSettings } from './theme-settings.ts'
import { renderThemeTable } from './theme-command.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { formatTokens } from './tokens.ts'
import { TranscriptModel } from './transcript.ts'
import { WorkFold, describeTodos } from './work.ts'
import { WorkDock } from './ui/dock.ts'
import { BoxedEditor } from './ui/editor.ts'
import { MarkdownRenderer } from './ui/markdown.ts'
import {
  EffortPicker,
  PROVIDER_DEFAULT_EFFORT_ID,
  PresetPicker,
  SessionPicker,
  effortChoices,
  type PickerAction,
  type PickerCard,
} from './ui/picker.ts'
import { StatusBar } from './ui/status.ts'
import { DEFAULT_VIEW_STATE, TranscriptView } from './ui/view.ts'

export const name = 'tui'

/**
 * Services the surface cannot run without.
 *
 * `tools` is what lets a card read its tool's own render intent; a context that
 * has not injected it throws on the property read, which silently degraded
 * every card to a bare generic row.
 */
export const inject = ['agents', 'tools']

/** Keys the surface answers itself, listed wherever the reader asks for help. */
const LOCAL_KEYS = 'ctrl+o tool detail · ctrl+y nested calls · shift+tab reasoning · ctrl+t reasoning effort · ctrl+b back to this session · ctrl+c interrupt or exit'

/** The one thing to say about a view a reader did not open. */
const LOCAL_KEYS_BACK = 'ctrl+b returns'

/** Stored sessions titled at once when the picker opens. */
const TITLE_CONCURRENCY = 4

/** How often the running-state clock repaints while a turn is open. */
const STATUS_TICK_MS = 1000


function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/**
 * The command registry, described structurally: the surface only lists,
 * looks up, and dispatches human commands, so it does not depend on the
 * command package's full surface.
 */
interface CommandRegistry {
  list(agent: Agent): readonly { readonly name: string; readonly description: string }[]
  find(agent: Agent, name: string): unknown
  execute(agent: Agent, line: string, attachments: readonly unknown[], signal: AbortSignal): Promise<
    { readonly result: { readonly kind: 'success' | 'error'; readonly text?: string } } | undefined
  >
}

/**
 * Refuse to run without a real terminal.
 *
 * A terminal surface that silently degrades to line mode hides deployment
 * mistakes and changes interaction semantics, so an unattended invocation
 * fails loud instead: a caller that wants one-shot output uses headless mode.
 */
export function assertInteractiveTerminal(input: {
  readonly stdinIsTTY?: boolean
  readonly stdoutIsTTY?: boolean
} = {}): void {
  const stdin = input.stdinIsTTY ?? process.stdin.isTTY === true
  const stdout = input.stdoutIsTTY ?? process.stdout.isTTY === true
  if (!stdin || !stdout) {
    throw new Error('dsh-tui: both stdin and stdout must be TTYs; run this profile from a terminal or SSH session')
  }
}

/**
 * Mount the terminal surface over the composed agent plane.
 *
 * The plugin owns input and presentation only: agent lifecycle, session
 * persistence, tool execution, and the model-facing question tool stay with
 * the composition rows around it.
 */
export function apply(ctx: Context, config: unknown): void {
  const resolved = resolveConfig(config)
  assertInteractiveTerminal()

  // Fail before taking the screen over: a missing row is a composition mistake,
  // and the reader deserves the row name rather than a stack trace mid-turn.
  const probe = probeComposition(service => ctx.get(service) !== undefined)
  if (probe.missingRequired.length > 0) throw new Error(describeMissingRequired(probe))
  const appExit = ctx.get('appExit')
  if (appExit === undefined) {
    throw new Error('dsh-tui: the dsh launcher must provide appExit; start this surface with dsh --profile tui')
  }

  /**
   * The surface's appearance, rebuilt whenever the reader's settings change.
   *
   * Renderers hold this object for the life of the session, so the current
   * theme is swapped *behind* a stable delegate rather than reassigned: every
   * row then reads one whole table, and a repaint can never observe a
   * half-applied one. `--no-color` still outranks anything configured.
   */
  const themeMode = (): ColourMode => (resolved.color ? detectColourMode(process.env) : 'none')
  /**
   * The reader's section, or nothing when the service is not mounted.
   *
   * The service is only readable inside an `inject` scope — asking for it
   * outside one is a composition error, not a missing value — so this stays a
   * late-bound read that the injection point and the change event both use.
   */
  let readSection = (): TuiSettings => defaultSettings()
  /** A refused settings edit, kept until the surface can show it: stderr is behind the alt screen. */
  let pendingSettingsProblem: string | undefined
  let current = createTheme(themeMode())
  const applyTheme = (): void => {
    current = createTheme(themeMode(), toOverrides(readSection()))
  }
  const theme: TuiTheme = {
    get revision() { return current.revision },
    get color() { return current.color },
    style: (token, text) => current.style(token, text),
    cut: (text, width, ellipsis) => current.cut(text, width, ellipsis),
    glyph: token => current.glyph(token),
    visible: token => current.visible(token),
    // Forwarded rather than read, because the editor and the markdown view keep
    // the theme object they were built with: a settings change has to reach them
    // through a stable delegate or they would keep the boot appearance.
    editor: forwardEditorTheme(() => current.editor),
    markdown: forwardMarkdownTheme(() => current.markdown),
  }
  /**
   * Rows the reader has opened. The model stays untouched; only the view reads
   * this. A thought starts folded: it is the longest, least scannable row in the
   * transcript, so leaving it open pushes the answer a reader came for off the
   * screen, and a folded row still names itself and its key. A PTC card's calls
   * start open for the opposite reason: each is one clipped line under a header
   * that already names the program.
   */
  const viewState = { ...DEFAULT_VIEW_STATE }
  /**
   * Seed the nested-call display the reader configured.
   *
   * The key toggles it for one session, but a settings edit is a deliberate act,
   * so it re-seeds and becomes the new starting point.
   */
  const applyDisplay = (): void => {
    viewState.expandSubCalls = readSection().subcalls === 'inline'
  }
  /**
   * Own the section, so the harness validates and persists it for the reader.
   *
   * Registration is how the document learns the section exists at all; without
   * it a hand-written `dsh-tui:` block would be dropped on the next save. The
   * first read happens here too, because this is the only scope the service
   * may be touched in.
   */
  ctx.inject(['settings'], settingsCtx => {
    const scope = settingsCtx.settings.register(TUI_SETTINGS_NAMESPACE, TuiSettingsSchema)
    readSection = () => readScope(scope, message => { pendingSettingsProblem = message })
    applyTheme()
    applyDisplay()
  })
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
  const modelSwitch = new ModelSwitch()
  const agentPresets = createPresetRoster(ctx)
  /** The mode named on the command line, which is the only one that may conflict. */
  const requestedPreset = resolved.preset
  /**
   * The mode a session the reader starts from here on joins.
   *
   * A launch flag seeds it and a successful switch updates it, so `/new` and
   * `/fork` land in the mode the reader last chose; nothing is written to
   * settings, because the mode of a session is not a property of the machine.
   * Unset means nobody chose, which is where the roster's default applies.
   */
  let seat = requestedPreset
  /**
   * The mode a session takes its seat in: the reader's latest choice, or the
   * roster's default read at this moment.
   *
   * The default cannot be captured when this row applies: it comes from the
   * settings document, which may be read after that, so a captured copy would
   * pin every later session to the mode the bundle happened to ship.
   */
  const seatMode = (): string | undefined => seat ?? agentPresets?.defaultId
  const catalog = createModelCatalog(ctx)
  const jobDirectory = createJobDirectory(ctx)
  let jobs: readonly JobSummary[] = []
  const roster = new SubagentRoster()
  const subagentControl = createSubagentControl(ctx)
  const markdown = new MarkdownRenderer(theme.markdown)
  const restore = createRestoreRegistry()
  const terminal = new ProcessTerminal()
  const tui = new WarningSafeTui(terminal)
  /** The one gate a terminal can present at a time, and how it settles its caller. */
  type PendingGate =
    | { readonly kind: 'approval'; readonly gate: ApprovalGate; readonly settle: (outcome: ApprovalOutcome) => void }
    | { readonly kind: 'question'; readonly gate: QuestionGate; readonly settle: (answers: GateAnswer[]) => void }

  /** The session this surface drives: commands, approvals, and the bell belong to it. */
  let activeSession = resolved.sessionId
  /** The session the transcript is showing, which can be one of its children. */
  let viewedSession = resolved.sessionId
  /** The one picker a terminal can present at a time, and how it settles its caller. */
  interface PendingPicker {
    readonly picker: { handleKey(data: string): PickerAction | undefined; card(): PickerCard; setNote(text: string | undefined): void }
    readonly settle: (id: string | undefined) => void
    /**
     * Why this run cannot open an id, or undefined when it can.
     *
     * Asked before a pick settles, so a refusal the reader can act on stays in
     * the menu they are already looking at instead of ending the run.
     */
    readonly vet: ((id: string) => Promise<string | undefined>) | undefined
  }
  let pending: PendingGate | undefined
  let pendingPicker: PendingPicker | undefined
  /** A pick being vetted owns the keyboard: a key would answer what is unanswered. */
  let vetting = false
  const view = new TranscriptView(model, theme, markdown, {
    state: () => viewState,
    gate: () => pending?.gate.card(),
    picker: () => pendingPicker?.picker.card(),
  })
  const editor = new BoxedEditor(tui, theme.editor)
  const disposers: Array<() => void> = []
  // The presenter closure outlives the composition's own teardown, so it must
  // not keep an agent alive after its world unwinds.
  disposers.push(() => {
    presentScope = undefined
  })
  let agent: TuiAgent | undefined
  let turnOpen = false
  let turnStartedAt: number | undefined
  let exited = false
  /** Whether a session was really opened, which is what an exit hint can name. */
  let sessionOpened = false
  /** Re-read the job board; it is live state, so nothing else can fold it. */
  const refreshJobs = (): void => {
    jobs = agent === undefined || jobDirectory === undefined ? [] : jobDirectory.list(agent.agent)
    tui.requestRender()
  }

  const statusFacts = createStatusFacts(ctx, {
    sessionId: () => activeSession,
    activity: () => ({ running: turnOpen, startedAt: turnStartedAt }),
    override: () => modelSwitch.current(),
    home: process.env.HOME,
  })
  const statusBar = new StatusBar(statusFacts, theme)
  const dock = new WorkDock(() => work.state(), theme, () => jobs, () => roster.list())
  // Only a running turn has anything to say over time, so the clock stops with it.
  const statusTicker: ReturnType<typeof setInterval> = setInterval(() => {
    if (turnOpen) tui.requestRender()
  }, STATUS_TICK_MS)
  disposers.push(() => clearInterval(statusTicker))

  restore.add(() => tui.stop())
  ctx.effect(() => () => {
    restore.restore()
    for (const dispose of disposers.reverse()) dispose()
  })

  tui.setLayoutRoot(new VStack([
    {
      component: new ScrollView(view, { follow: 'end', primary: true, overscroll: 'chain' }),
      basis: 0,
      grow: 1,
      minSize: 1,
    },
    // Work state earns rows only when there is some: a dock that always
    // occupied a row would cost every conversation one line of transcript.
    { component: dock, basis: 'auto', shrink: 0, minSize: 0 },
    { component: new VStack([{ component: editor, basis: 'auto', shrink: 1, minSize: 1 }]), basis: 'auto', shrink: 1, minSize: 1 },
    { component: statusBar, basis: 'auto', shrink: 0, minSize: 1 },
  ]))
  tui.setFocus(editor)

  const requestExit = (code: number, reason?: string): void => {
    if (exited) return
    exited = true
    clearInterval(statusTicker)
    // Hand the window label back before the screen does, so a shell that sets
    // its own title can take over cleanly.
    terminal.write(CLEAR_TITLE)
    restore.restore()
    // Everything below is written after the release: the alternate screen closes
    // over whatever was painted on it, and a failure nobody can read is not a
    // failure that was reported.
    if (reason !== undefined) terminal.write(`\ndsh-tui: ${reason}\n`)
    // The hint is computed here rather than read from the context because only
    // the surface knows which session it is leaving: a fork or a switch moves it.
    // A run that opened nothing has nothing to offer back: the identity it was
    // launched with names no log, so pointing at it would send the reader to a
    // conversation that does not exist.
    if (sessionOpened) terminal.write(`\n${resumeHint(String(activeSession), PROFILE_NAME)}\n`)
    appExit(code)
  }

  const openGate = (next: PendingGate): void => {
    pending = next
    // A gate owns the keyboard: the editor must not collect the decision keys.
    editor.disableSubmit = true
    tui.setFocus(null)
    tui.requestRender()
  }

  const closeGate = (): void => {
    pending = undefined
    editor.disableSubmit = false
    tui.setFocus(editor)
    tui.requestRender()
  }

  disposers.push(tui.addInputListener(data => {
    // A key arrives as a press and a release once the surface asks the terminal
    // to report key events, and this library drops the release only for the
    // focused component: a listener sees both halves, so an arrow key that is
    // acted on twice steps a picker two rows and answers a question two options
    // on. Falls through rather than consuming, which leaves a component that
    // asked for releases its own half.
    if (isKeyRelease(data)) return undefined
    if (pending !== undefined) {
      if (pending.kind === 'approval') {
        const outcome = pending.gate.handleKey(data)
        if (outcome === undefined) tui.requestRender()
        else {
          pending.settle(outcome)
          closeGate()
        }
      } else {
        const answers = pending.gate.handleKey(data)
        if (answers === undefined) tui.requestRender()
        else {
          pending.settle(answers)
          closeGate()
        }
      }
      return { consume: true }
    }
    if (pendingPicker !== undefined) {
      if (vetting) return { consume: true }
      const action = pendingPicker.picker.handleKey(data)
      if (action === undefined) {
        tui.requestRender()
        return { consume: true }
      }
      if (action.kind === 'cancel') {
        settlePicker(undefined)
        return { consume: true }
      }
      const vet = pendingPicker.vet
      if (vet === undefined) {
        settlePicker(action.id)
        return { consume: true }
      }
      vetting = true
      void (async () => {
        let reason: string | undefined
        try {
          reason = await vet(action.id)
        } finally {
          // A check that fails must not take the keyboard with it.
          vetting = false
        }
        if (pendingPicker === undefined) return
        if (reason === undefined) {
          settlePicker(action.id)
          return
        }
        pendingPicker.picker.setNote(reason)
        tui.requestRender()
      })()
      return { consume: true }
    }
    // Detail the reader asked for is always available, even mid-turn: the
    // collapsed view is a default, not the only state.
    if (matchesKey(data, 'ctrl+o')) {
      viewState.expandCards = !viewState.expandCards
      tui.requestRender()
      return { consume: true }
    }
    if (matchesKey(data, 'shift+tab')) {
      viewState.expandReasoning = !viewState.expandReasoning
      tui.requestRender()
      return { consume: true }
    }
    if (matchesKey(data, 'ctrl+y')) {
      viewState.expandSubCalls = !viewState.expandSubCalls
      tui.requestRender()
      return { consume: true }
    }
    if (matchesKey(data, 'ctrl+t')) {
      void openEffortPicker()
      return { consume: true }
    }
    if (matchesKey(data, 'ctrl+b')) {
      if (viewedSession !== activeSession) void showAgentSession()
      return { consume: true }
    }
    // In raw mode Ctrl+C never reaches the process as SIGINT, so the surface
    // decides: stop the work in flight, or leave when there is none.
    if (!matchesKey(data, 'ctrl+c')) return undefined
    if (turnOpen) {
      agent?.interrupt()
      model.notice('interrupt requested')
      tui.requestRender()
      return { consume: true }
    }
    requestExit(0)
    return { consume: true }
  }))

  const registry = (): CommandRegistry | undefined => ctx.get('commands') as CommandRegistry | undefined

  /**
   * Offer completion for whatever this session can run right now.
   *
   * The registry is agent-scoped and still empty while the agent starts, so the
   * menu is rebuilt when the agent arrives and whenever a package registers
   * another command.
   */
  const installCompletion = (): void => {
    const current = agent?.agent
    const commands = registry()
    if (current === undefined || commands === undefined) return
    editor.setAutocompleteProvider(createCompletionProvider(commands.list(current), process.cwd()))
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
    const picked = await openPicker(new SessionPicker(sessions, () => titles), refuseReason)
    return picked === undefined ? undefined : SessionId(picked)
  }

  /** Give the keyboard back to the editor and answer whoever opened the picker. */
  const settlePicker = (id: string | undefined): void => {
    const settle = pendingPicker?.settle
    pendingPicker = undefined
    editor.disableSubmit = false
    tui.setFocus(editor)
    settle?.(id)
    tui.requestRender()
  }

  /**
   * Why this run cannot open a stored session, or undefined when it can.
   *
   * A session runs the mode its own log recorded, so a `--preset` that
   * disagrees with it can only be refused: the picker asks first so the refusal
   * lands in the list rather than after the terminal has been handed back.
   */
  const refuseReason = async (id: string): Promise<string | undefined> => {
    if (requestedPreset === undefined || agentPresets === undefined) return undefined
    try {
      await presetFor(SessionId(id), true, undefined)
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  /** Take the keyboard for a picker and answer with the id it settled on. */
  const openPicker = (
    picker: PendingPicker['picker'],
    vet?: (id: string) => Promise<string | undefined>,
  ): Promise<string | undefined> =>
    new Promise<string | undefined>(resolve => {
      pendingPicker = { picker, settle: resolve, vet }
      editor.disableSubmit = true
      tui.setFocus(null)
      tui.requestRender()
    })

  /** The roster as the picker paints it, refreshed when the picker opens. */
  let presetRows: readonly PresetSummary[] = []

  /** Choose the mode a session that has not started yet will run. */
  const askForPreset = async (currentId: string | undefined): Promise<string | undefined> => {
    if (agentPresets === undefined) return undefined
    presetRows = await agentPresets.list()
    return await openPicker(new PresetPicker(() => presetRows, () => currentId))
  }

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
          tui.requestRender()
        } catch {
          // A log this build cannot read stays listed by id; the picker is not
          // the place to explain storage, and one bad session is not the list.
        }
      }
    }
    await Promise.all(Array.from({ length: TITLE_CONCURRENCY }, worker))
  }

  const storedSessions = async (): Promise<{ history: SessionHistory; sessions: readonly StoredSession[] } | undefined> => {
    const history = createSessionHistory(ctx)
    if (history === undefined) {
      model.notice('this profile has no session storage, so there is nothing to resume')
      tui.requestRender()
      return undefined
    }
    try {
      const sessions = await history.list(PICKER_LIMIT)
      if (sessions.length === 0) {
        model.notice('no stored sessions to resume')
        tui.requestRender()
        return undefined
      }
      return { history, sessions }
    } catch (error) {
      model.notice(`could not list stored sessions: ${error instanceof Error ? error.message : String(error)}`)
      tui.requestRender()
      return undefined
    }
  }

  const chooseSession = async (): Promise<SessionId | undefined> => {
    const listed = await storedSessions()
    return listed === undefined ? undefined : askForSession(listed.history, listed.sessions)
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
  const liveSession = (id: SessionId): { snapshotEvents?: () => readonly ForkEvent[] } | undefined =>
    (ctx.get('sessions') as { get?: (id: SessionId) => { snapshotEvents?: () => readonly ForkEvent[] } | undefined } | undefined)?.get?.(id)

  /**
   * The fold's place in the viewed session's durable sequence.
   *
   * A resumed session is folded while its agent's loop is already live, so the
   * same event can reach the surface twice: once on the stream and once from the
   * log the fold is reading. The sequence number every durable event carries is
   * what tells the two apart.
   */
  const foldCursor = new FoldCursor()

  /** Feed one durable event to the model, unless a fold has already folded it. */
  const applyDurable = (event: ForkEvent): void => {
    if (foldCursor.accept(event)) applyEvent(event)
  }

  const foldHistory = async (id: SessionId): Promise<number> => {
    // Resolved before the fold so every card reads its tool through the scope
    // that actually registered it; a stored session nobody runs has none.
    presentScope = ctx.agents?.get(id)
    // Every fold starts a cleared transcript, so this session's own numbering is
    // where the cursor begins rather than the previous session's.
    foldCursor.reset()
    const inMemory = liveSession(id)?.snapshotEvents?.()
    if (inMemory !== undefined) {
      for (const event of inMemory) applyDurable(event)
      return inMemory.length
    }
    const history = createSessionHistory(ctx)
    if (history === undefined) return 0
    const events = await history.read(id)
    for (const event of events) applyDurable(event)
    return events.length
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
    model.reset()
    work.reset()
    viewedSession = id
    try {
      await foldHistory(id)
    } catch (error) {
      model.notice(`could not read that session: ${error instanceof Error ? error.message : String(error)}`)
    }
    const returned = id === activeSession && previous !== activeSession
    model.marker(returned
      ? 'back to the session this terminal drives'
      : `viewing ${id}${id === activeSession ? '' : ` — ${LOCAL_KEYS_BACK}`}`)
    tui.requestRender()
  }

  const showAgentSession = async (): Promise<void> => {
    await showSession(activeSession)
  }

  /** Feed one durable event to everything that folds it. */
  const applyEvent = (event: { readonly type: string; readonly data?: unknown }): void => {
    model.apply(event)
    work.apply(event)
  }

  /** Every event of a session, from memory when this process runs it. */
  const sessionEvents = async (id: SessionId): Promise<readonly ForkEvent[]> => {
    const inMemory = liveSession(id)?.snapshotEvents?.()
    if (inMemory !== undefined) return inMemory
    const history = createSessionHistory(ctx)
    return history === undefined ? [] : history.read(id)
  }

  /**
   * The mode one agent joins.
   *
   * A resumed session keeps the composition its own log recorded, because
   * swapping it would leave logged tool calls the new composition cannot make —
   * the same reason the harness refuses a switch once a turn has run. A session
   * that recorded none, which is every session written before modes existed,
   * takes the seat; a branch inherits the mode its parent is running.
   */
  const presetFor = async (id: SessionId, resume: boolean, fork: ForkInheritance | undefined): Promise<string | undefined> => {
    if (agentPresets === undefined) return undefined
    if (fork !== undefined) return agentPresets.current(liveSession(fork.from)) ?? seatMode()
    if (!resume) return seatMode()
    const history = createSessionHistory(ctx)
    const stored = history === undefined ? undefined : await presetOfStoredSession(history, id)
    if (stored === undefined) return seatMode()
    const resolvedStored = await resolveStored(id, stored)
    if (resolvedStored === undefined) {
      // The composition this session recorded is gone. Naming one explicitly is
      // the reader's only way forward, so that is the one case an override is
      // taken for a stored session.
      if (requestedPreset !== undefined) return (await agentPresets.resolve(requestedPreset)).id
      throw new Error(
        `session ${id} runs mode "${stored}", which this roster no longer offers; name another with --preset`,
      )
    }
    if (requestedPreset !== undefined && requestedPreset !== resolvedStored) {
      throw new Error(
        `session ${id} runs mode "${resolvedStored}", so --preset ${requestedPreset} does not apply; /preset ${requestedPreset} switches it before its first turn`,
      )
    }
    return resolvedStored
  }

  /** The stored mode's roster row, or undefined when the roster no longer offers it. */
  const resolveStored = async (id: SessionId, stored: string): Promise<string | undefined> => {
    try {
      return (await agentPresets?.resolve(stored))?.id
    } catch {
      return undefined
    }
  }

  const openAgent = async (id: SessionId, resume: boolean, fork?: ForkInheritance): Promise<void> => {
    // Settled before the transcript is touched, so a refusal leaves neither a
    // half-replayed session nor a half-composed agent behind.
    const preset = await presetFor(id, resume, fork)
    const handle = await startAgent(ctx, {
      sessionId: id,
      resume,
      model: resolved.model,
      provider: resolved.provider,
      cwd: process.cwd(),
      preset,
      setup: async agentCtx => {
        modelSwitch.install(agentCtx)
        if (preset !== undefined) await agentPresets?.mount(agentCtx, preset)
      },
      ...(fork === undefined ? {} : { fork }),
    })
    sessionOpened = true
    activeSession = id
    viewedSession = id
    agent = handle
    // A session with no history to fold still has to present its first live
    // card through the right scope, so the scope is set before any event can.
    presentScope = handle.agent
    // Replayed only once the agent exists, because the fold reads every card
    // through the scope the preset mounted; a fold before that scope existed
    // degraded each replayed card to a bare generic row. The agent's loop is
    // live by now, so the fold and the stream race over the same events; the
    // durable sequence number is what keeps one event from landing twice.
    if (resume) await replayHistory(id)
    // A branch inherits the conversation the reader was already reading, so it
    // opens on that history rather than on an empty screen.
    if (fork !== undefined) await foldHistory(id)
    disposers.push(() => {
      void handle.dispose()
    })
    installCompletion()
    model.notice(`session ${handle.sessionId}${resume ? ' (resumed)' : ''}`)
    tui.requestRender()
  }

  /** Move the surface to another stored session without leaving the terminal. */
  const switchSession = async (id: SessionId): Promise<void> => {
    const previous = agent
    agent = undefined
    // Drop the outgoing scope before its agent is disposed, so no card folded
    // during the transition can read a torn-down world.
    presentScope = undefined
    turnOpen = false
    model.reset()
    work.reset()
    roster.reset()
    if (previous !== undefined) await previous.dispose()
    await openAgent(id, true)
  }

  /**
   * Show or choose the route the next step will use.
   *
   * The choice is session-scoped: it changes nothing about the settings a later
   * run reads, and the loop logs its own durable notice when the route a request
   * actually used changes.
   */
  /**
   * Show, read, or kill a background job.
   *
   * A terminal has no second window, so a job started by the model is otherwise
   * invisible: the board is the only place a reader can see what is still
   * running and stop it.
   */
  /**
   * List or stop the delegations this session started.
   *
   * A child runs in the same process as an ordinary agent, so a stop is the
   * cancel a reader's Ctrl+C sends to the parent; nothing here reaches into the
   * child's own session, which keeps its own transcript either way.
   */
  const runSubagentsCommand = (argument: string): void => {
    const command = parseSubagentsArgument(argument)
    switch (command.kind) {
      case 'list':
        model.notice(describeSubagents(roster.list(), Date.now()))
        tui.requestRender()
        return
      case 'open': {
        const run = resolveRun(roster.list(), command.id)
        if (run === undefined) {
          model.notice(`${command.id}: no single child matches; /subagents lists them`)
          tui.requestRender()
          return
        }
        void showSession(SessionId(run.id))
        return
      }
      case 'kill': {
        const stopped = subagentControl?.stop(command.id) ?? false
        model.notice(stopped
          ? `${command.id}: stop requested`
          : `${command.id}: no live child with that id`)
        tui.requestRender()
        return
      }
      case 'invalid':
        model.notice(`/subagents: ${command.reason}`)
        tui.requestRender()
        return
    }
  }

  const runJobsCommand = (argument: string): void => {
    if (jobDirectory === undefined) {
      model.notice('this profile has no job registry, so there is nothing to list')
      tui.requestRender()
      return
    }
    if (agent === undefined) {
      model.notice('the agent is still starting; try again in a moment')
      tui.requestRender()
      return
    }
    const command = parseJobsArgument(argument)
    switch (command.kind) {
      case 'list':
        refreshJobs()
        model.notice(describeJobs(jobs, Date.now()))
        tui.requestRender()
        return
      case 'read': {
        const result = jobDirectory.read(agent.agent, command.id)
        const text = result?.text.trim() ?? ''
        model.notice(text === ''
          ? `${command.id}: no output yet`
          : `${command.id} output\n${text.split('\n').slice(-JOB_READ_LINES).join('\n')}`)
        refreshJobs()
        return
      }
      case 'kill': {
        const outcome = jobDirectory.kill(agent.agent, command.id)
        model.notice(outcome === undefined
          ? `${command.id}: no such job`
          : outcome === 'requested' ? `${command.id}: stop requested` : `${command.id} had already finished`)
        refreshJobs()
        return
      }
      case 'invalid':
        model.notice(`/jobs: ${command.reason}`)
        tui.requestRender()
        return
    }
  }

  /**
   * Give this session a title.
   *
   * The title is what the resume picker shows and what every other surface
   * displays, so a reader who has several sessions can name the one they are in
   * without waiting for the harness to guess.
   */
  /**
   * Write what the reader can see to a file.
   *
   * The base's `/export` downloads the log through the browser, which a
   * terminal has no way to do, so this dumps the transcript the reader is
   * looking at — the thing worth pasting into a message.
   */
  const runExportCommand = (argument: string): void => {
    const path = resolve(argument === '' ? defaultExportFile(String(activeSession)) : argument)
    try {
      writeFileSync(path, transcriptToText(model.entries()), 'utf8')
      model.notice(`transcript written to ${path}`)
    } catch (error) {
      model.notice(`could not write ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
    tui.requestRender()
  }

  /**
   * Branch this conversation and continue in the branch.
   *
   * The branch is a real session with its own identity that inherits a prefix
   * of this one, so a reader can try something without spending the
   * conversation they already had. The cut is anchored to the last completed
   * turn, because half an exchange is not a state to hand a model.
   */
  /** Start a fresh session without leaving the terminal. */
  const runNewCommand = (title: string): void => {
    if (agent === undefined) {
      model.notice('the agent is still starting; try again in a moment')
      tui.requestRender()
      return
    }
    void (async () => {
      const previous = agent
      agent = undefined
      turnOpen = false
      turnStartedAt = undefined
      model.reset()
      work.reset()
      roster.reset()
      if (previous !== undefined) await previous.dispose()
      await openAgent(SessionId(`tui-session-${randomUUID()}`), false)
      if (title !== '') runRenameCommand(title)
      model.notice('started a new session')
      tui.requestRender()
    })().catch((error: unknown) => {
      model.notice(`could not start a session: ${error instanceof Error ? error.message : String(error)}`)
      tui.requestRender()
    })
  }

  /** Show the todo list the agent has been keeping. */
  const runTodoCommand = (): void => {
    model.notice(describeTodos(work.state().todos))
    tui.requestRender()
  }

  /**
   * Put the last answer on the reader's clipboard.
   *
   * The clipboard belongs to the terminal, so this asks it through OSC 52 —
   * which is also the only route that works over SSH.
   */
  const runCopyCommand = (): void => {
    const last = [...model.entries()].reverse().find(entry => entry.kind === 'assistant')
    if (last === undefined || last.kind !== 'assistant') {
      model.notice('nothing to copy yet')
      tui.requestRender()
      return
    }
    terminal.write(clipboardSequence(last.text))
    model.notice(`copied ${last.text.length} characters through the terminal`)
    tui.requestRender()
  }

  const runForkCommand = (title: string): void => {
    if (agent === undefined) {
      model.notice('the agent is still starting; try again in a moment')
      tui.requestRender()
      return
    }
    void (async () => {
      const source = activeSession
      const events = await sessionEvents(source)
      const point = forkPoint(events)
      if (point === undefined) {
        model.notice('nothing to fork yet: this session has no completed turn')
        tui.requestRender()
        return
      }
      const childId = SessionId(`tui-session-${randomUUID()}`)
      const previous = agent
      agent = undefined
      turnOpen = false
      turnStartedAt = undefined
      model.reset()
      work.reset()
      roster.reset()
      if (previous !== undefined) await previous.dispose()
      await openAgent(childId, false, { from: source, events: events.slice(0, point.inheritedEvents) })
      if (title !== '') runRenameCommand(title)
      model.notice(`forked from ${source} at event ${point.boundarySeq} — ${point.inheritedEvents} inherited`)
      tui.requestRender()
    })().catch((error: unknown) => {
      model.notice(`could not fork: ${error instanceof Error ? error.message : String(error)}`)
      tui.requestRender()
    })
  }

  const runRenameCommand = (title: string): void => {
    if (title === '') {
      model.notice('use /rename <title>; the title is what the resume picker shows')
      tui.requestRender()
      return
    }
    const session = (ctx.get('sessions') as { get?: (id: SessionId) => unknown } | undefined)?.get?.(activeSession)
    const titles = ctx.get('sessionTitle') as { rename?: (session: unknown, title: string) => { readonly title?: string } } | undefined
    if (session === undefined || typeof titles?.rename !== 'function') {
      model.notice('this profile has no session-title service, so this session cannot be renamed')
      tui.requestRender()
      return
    }
    try {
      const accepted = titles.rename(session, title)
      model.notice(`session renamed to "${typeof accepted?.title === 'string' ? accepted.title : title}"`)
    } catch (error) {
      model.notice(`could not rename: ${error instanceof Error ? error.message : String(error)}`)
    }
    tui.requestRender()
  }

  const runModelCommand = (argument: string): void => {
    if (catalog === undefined) {
      model.notice('this profile has no llm service, so models cannot be listed or switched')
      tui.requestRender()
      return
    }
    const command = parseModelArgument(argument, catalog.providers(), modelSwitch.current())
    switch (command.kind) {
      case 'current': {
        const facts = statusFacts()
        const current = modelSwitch.current()
        const route = current === undefined
          // Without a choice of its own the surface reports what the next step
          // would actually use, not that it has no opinion.
          ? `${facts.model ?? 'unset'}${facts.effort === undefined ? '' : ` (${facts.effort})`} · composition default`
          : `${current.provider}/${current.model}${current.reasoningEffort === undefined ? '' : ` (${current.reasoningEffort})`}`
        const providers = catalog.providers().map(provider => provider.id)
        model.notice(`model ${route} · providers: ${providers.length === 0 ? 'none' : providers.join(', ')} · /model <provider>/<model>[/<effort>] switches, /model <provider> lists its models`)
        tui.requestRender()
        return
      }
      case 'list-models':
        void catalog.models(command.provider).then(entries => {
          model.notice(entries.length === 0
            ? `${command.provider} advertises no models; an id may still work`
            : `${command.provider}: ${entries.map(entry => entry.id).join(' ')}`)
          tui.requestRender()
        }).catch((error: unknown) => {
          model.notice(`could not list models: ${error instanceof Error ? error.message : String(error)}`)
          tui.requestRender()
        })
        return
      case 'switch': {
        const choice = command.choice
        if (choice.reasoningEffort === undefined) {
          modelSwitch.choose(choice)
          model.notice(`model set to ${choice.provider}/${choice.model} for the next step`)
          tui.requestRender()
          return
        }
        // The route decides which efforts exist, so an explicit one is checked
        // against the adapter before it is put in force: a typo must not become
        // a request the provider rejects.
        void (async () => {
          try {
            const info = await catalog.efforts(choice.provider, choice.model)
            const efforts = info?.efforts ?? []
            if (!efforts.some(effort => effort.id === choice.reasoningEffort)) {
              model.notice(efforts.length === 0
                ? `/model: ${choice.provider}/${choice.model} advertises no reasoning efforts`
                : `/model: ${choice.provider}/${choice.model} does not offer reasoning effort "${choice.reasoningEffort}" — offers: ${efforts.map(effort => effort.id).join(' ')}`)
              tui.requestRender()
              return
            }
            modelSwitch.choose(choice)
            model.notice(`model set to ${choice.provider}/${choice.model} (${choice.reasoningEffort}) for the next step`)
          } catch (error) {
            model.notice(`/model: could not read reasoning efforts: ${error instanceof Error ? error.message : String(error)}`)
          }
          tui.requestRender()
        })()
        return
      }
      case 'invalid':
        model.notice(`/model: ${command.reason}`)
        tui.requestRender()
        return
    }
  }

  /** Whether a route's effort list is being read, so a second key cannot race it. */
  let openingEfforts = false

  /** Put the reader's effort choice in force for the next step. */
  const applyEffort = (provider: string, modelId: string, effortId: string): void => {
    modelSwitch.choose(effortId === PROVIDER_DEFAULT_EFFORT_ID
      ? { provider, model: modelId }
      : { provider, model: modelId, reasoningEffort: effortId })
    model.notice(`reasoning effort for ${provider}/${modelId} set to ${effortId === PROVIDER_DEFAULT_EFFORT_ID ? 'provider default' : effortId} for the next step`)
    tui.requestRender()
  }

  /**
   * Offer the efforts the route in force advertises.
   *
   * The list is read before the picker opens because the rows are the route's
   * own metadata; a menu painted before that arrived could offer a level the
   * request would then be refused for.
   */
  const openEffortPicker = async (): Promise<void> => {
    if (catalog === undefined) {
      model.notice('this profile has no llm service, so reasoning efforts cannot be read')
      tui.requestRender()
      return
    }
    const facts = statusFacts()
    if (facts.provider === undefined || facts.model === undefined) {
      model.notice('no model route is in use; /model <provider>/<model> picks one first')
      tui.requestRender()
      return
    }
    if (openingEfforts) return
    openingEfforts = true
    try {
      const info = await catalog.efforts(facts.provider, facts.model)
      const efforts = info?.efforts ?? []
      if (efforts.length === 0) {
        model.notice(`${facts.provider}/${facts.model} advertises no reasoning efforts`)
        return
      }
      const picked = await openPicker(new EffortPicker(
        () => effortChoices(efforts, facts.effort),
        `reasoning effort · ${facts.provider}/${facts.model}`,
      ))
      if (picked !== undefined) applyEffort(facts.provider, facts.model, picked)
    } catch (error) {
      model.notice(`could not read reasoning efforts: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      openingEfforts = false
      tui.requestRender()
    }
  }

  /**
   * Show or choose the mode this session runs.
   *
   * The mode decides which tools, prompt sections, and skills exist at all, so
   * it is fixed once a turn has run: the harness refuses the swap and this
   * surface explains why rather than pretending otherwise. Before the first
   * turn the switch is recorded in the log, which is what keeps the transcript
   * honest about the composition later turns ran under.
   */
  const runPresetCommand = (argument: string): void => {
    if (agentPresets === undefined) {
      model.notice('this profile has no agent roster, so there is no mode to choose')
      tui.requestRender()
      return
    }
    if (agent === undefined) {
      model.notice('the agent is still starting; try again in a moment')
      tui.requestRender()
      return
    }
    const session = agent.agent.session
    const current = agentPresets.current(session)
    const command = parsePresetArgument(argument)
    if (command.kind === 'pick') {
      if (agentPresets.started(session)) {
        model.notice(`this session runs ${current === undefined ? 'a mode' : `"${current}"`} and has already started, so its mode is fixed — /new starts a fresh session`)
        tui.requestRender()
        return
      }
      void askForPreset(current).then(picked => picked === undefined ? undefined : applyPreset(picked))
      return
    }
    void applyPreset(command.id)
  }

  /** Join this session to another mode and remember it for the next session. */
  const applyPreset = async (id: string): Promise<void> => {
    if (agentPresets === undefined || agent === undefined) return
    try {
      const chosen = await agentPresets.select(agent.agent, id)
      seat = chosen
      // The durable selection is folded as a marker on the session it belongs
      // to, so a reader watching a child has to come back to see it.
      if (viewedSession !== activeSession) await showSession(activeSession)
    } catch (error) {
      model.notice(`could not switch the mode: ${error instanceof Error ? error.message : String(error)}`)
    }
    tui.requestRender()
  }

  const helpText = (): string => {
    const current = agent?.agent
    const registered = current === undefined || registry() === undefined
      ? []
      : registry()?.list(current).map(command => `/${command.name}`) ?? []
    const commands = registered.length === 0 ? 'none registered yet' : registered.join(' ')
    return `commands: ${commands} · surface: ${LOCAL_COMMANDS.join(' ')} · keys: ${LOCAL_KEYS}`
  }

  const runCommand = (name: string, line: string): void => {
    const current = agent
    const commands = registry()
    if (current === undefined) {
      model.notice('the agent is still starting; try again in a moment')
      tui.requestRender()
      return
    }
    if (commands === undefined || commands.find(current.agent, name) === undefined) {
      model.notice(`unknown command: /${name} — ${helpText()}`)
      tui.requestRender()
      return
    }
    const controller = new AbortController()
    void commands.execute(current.agent, line, [], controller.signal).then(execution => {
      const result = execution?.result
      if (result === undefined) return
      model.notice(result.kind === 'error' ? `/${name} failed: ${result.text ?? 'no detail'}` : `/${name} ${result.text ?? 'done'}`)
      tui.requestRender()
    }).catch((error: unknown) => {
      model.notice(`/${name} failed: ${error instanceof Error ? error.message : String(error)}`)
      tui.requestRender()
    })
  }

  /**
   * Put the deployment default in force before the first turn.
   *
   * The agent is created before the settings file has been read, so the route
   * its loop captured is the composition placeholder; the reader's default —
   * effort included — only exists by the time they can type. Adopting it here
   * is what makes the status line's route the one the request actually uses.
   */
  const adoptDefaultRoute = (): void => {
    if (modelSwitch.current() !== undefined) return
    const facts = statusFacts()
    if (facts.provider === undefined || facts.model === undefined) return
    modelSwitch.adopt({
      provider: facts.provider,
      model: facts.model,
      ...(facts.effort === undefined ? {} : { reasoningEffort: facts.effort }),
    })
  }

  editor.onSubmit = text => {
    const submission = classifySubmission(text)
    switch (submission.kind) {
      case 'empty':
        return
      case 'quit':
        requestExit(0)
        return
      case 'model':
        runModelCommand(submission.argument)
        return
      case 'preset':
        runPresetCommand(submission.argument)
        return
      case 'jobs':
        runJobsCommand(submission.argument)
        return
      case 'rename':
        runRenameCommand(submission.title)
        return
      case 'export':
        runExportCommand(submission.path)
        return
      case 'subagents':
        runSubagentsCommand(submission.argument)
        return
      case 'fork':
        runForkCommand(submission.title)
        return
      case 'new':
        runNewCommand(submission.title)
        return
      case 'todo':
        runTodoCommand()
        return
      case 'theme':
        for (const line of renderThemeTable(toOverrides(readSection()))) model.notice(line)
        tui.requestRender()
        return
      case 'copy':
        runCopyCommand()
        return
      case 'status': {
        const facts = statusFacts()
        const context = facts.contextTokens === undefined
          ? undefined
          : `context ${formatTokens(facts.contextTokens)}${facts.contextWindow === undefined ? '' : `/${formatTokens(facts.contextWindow)}`}`
        model.notice([
          `session ${activeSession}`,
          viewedSession === activeSession ? undefined : `viewing ${viewedSession}`,
          facts.model === undefined
            ? undefined
            : `model ${facts.provider === undefined ? '' : `${facts.provider}/`}${facts.model}${facts.effort === undefined ? '' : ` (${facts.effort})`}`,
          facts.agentPreset === undefined ? undefined : `mode ${facts.agentPreset}`,
          facts.preset === undefined ? undefined : `permissions ${facts.preset}`,
          context,
          facts.uncachedInputTokens === undefined && facts.outputTokens === undefined
            ? undefined
            : `tokens in ${formatTokens(facts.uncachedInputTokens ?? 0)} out ${formatTokens(facts.outputTokens ?? 0)}`,
          `cwd ${facts.cwd}`,
        ].filter(part => part !== undefined).join(' · '))
        tui.requestRender()
        return
      }
      case 'clear':
        model.reset()
        work.reset()
        tui.requestRender()
        return
      case 'help':
        model.notice(helpText())
        tui.requestRender()
        return
      case 'resume':
        void chooseSession().then(picked => picked === undefined ? undefined : switchSession(picked)).catch((error: unknown) => {
          model.notice(`could not resume: ${error instanceof Error ? error.message : String(error)}`)
          tui.requestRender()
        })
        return
      case 'command':
        runCommand(submission.name, submission.line)
        return
      case 'prompt':
        if (agent === undefined) {
          model.notice('the agent is still starting; try again in a moment')
          tui.requestRender()
          return
        }
        // While a turn is running the human is steering it, not opening another.
        if (turnOpen) agent.steer(submission.text)
        else {
          adoptDefaultRoute()
          agent.submit(submission.text)
        }
    }
  }

  disposers.push(ctx.on('session/event', (session, event) => {
    // The surface state — activity, timer, title, bell, job board — belongs to
    // the agent this terminal drives, even while a child is on screen.
    if (session.id === activeSession) {
      if (event.type === 'turn/start') {
        turnOpen = true
        turnStartedAt = Date.now()
        terminal.write(windowTitle(process.cwd(), 'working'))
      }
      if (event.type === 'turn/end') {
        const ranFor = turnStartedAt === undefined ? 0 : Date.now() - turnStartedAt
        turnOpen = false
        turnStartedAt = undefined
        terminal.write(windowTitle(process.cwd(), 'ready'))
        if (shouldRingBell({ bell: resolved.bell, ranForMs: ranFor, exiting: exited })) terminal.write(BELL)
        // A job the turn started may have settled while the reader was watching
        // something else, and nothing else refreshes a live board.
        refreshJobs()
      }
    }
    if (session.id !== viewedSession) return
    presentScope = ctx.agents?.get(session.id)
    applyDurable(event)
    tui.requestRender()
  }))

  /**
   * Subagent lifecycle arrives as a service event rather than a session event,
   * so it is decoration in the transcript: the durable record of a delegation
   * is the tool call that asked for it. The name is cast so a rename in the
   * harness cannot break compilation of this surface.
   */
  const listenFor = (name: string, handler: (...args: readonly unknown[]) => void): (() => void) =>
    (ctx.on as unknown as (event: string, listener: (...args: readonly unknown[]) => void) => () => void)(name, handler)

  disposers.push(listenFor('subagent/start', info => {
    roster.start(info)
    const record = asRecord(info)
    const provider = typeof record?.provider === 'string' ? record.provider : 'subagent'
    const id = typeof record?.id === 'string' ? record.id : ''
    model.marker(`subagent ${provider} started${id === '' ? '' : ` · ${id}`}`)
    tui.requestRender()
  }))

  disposers.push(listenFor('subagent/end', info => {
    roster.end(info)
    const record = asRecord(info)
    const provider = typeof record?.provider === 'string' ? record.provider : 'subagent'
    const stop = typeof record?.stopReason === 'string' ? record.stopReason : undefined
    model.marker(`subagent ${provider} finished${stop === undefined ? '' : ` · ${stop}`}`)
    tui.requestRender()
  }))

  // Answering these two waterfalls is what makes a terminal surface usable at
  // all: without an answerer every gated tool fails closed, and the model's
  // questions never reach the human.
  disposers.push(ctx.on('approval/request', (request, next) => {
    if (request.agent.id !== activeSession) return next()
    return new Promise<ApprovalOutcome>(resolve => {
      const gate = new ApprovalGate(request.toolName, request.reason)
      request.signal?.addEventListener('abort', () => {
        gate.cancel()
        if (pending?.gate === gate) closeGate()
        resolve('cancelled')
      }, { once: true })
      openGate({ kind: 'approval', gate, settle: resolve })
    })
  }))

  disposers.push(ctx.on('user-questions/request', (request, next) => {
    const agentId = (request as { agent?: { id?: string } }).agent?.id
    if (agentId !== undefined && agentId !== activeSession) return next()
    const questions = toGateQuestions(request)
    if (questions.length === 0) return next()
    return new Promise<AskUserQuestionAnswer>(resolve => {
      const gate = new QuestionGate(questions)
      // The seam takes mutable selection arrays and an optional custom field, so
      // the read-only gate answer is copied into that exact shape here.
      openGate({
        kind: 'question',
        gate,
        settle: answers => resolve({
          answers: answers.map(answer => ({
            id: answer.id,
            selected: [...answer.selected],
            ...(answer.custom === undefined ? {} : { custom: answer.custom }),
          })),
        }),
      })
    })
  }))

  disposers.push(ctx.on('commands/change', () => installCompletion()))

  // The board is live state: watch it directly rather than folding events.
  disposers.push(jobDirectory?.watch(owner => {
    if (owner !== undefined && (owner as { id?: string }).id !== activeSession) return
    refreshJobs()
  }) ?? (() => {}))

  disposers.push(ctx.on('agent/error', payload => {
    if (payload.agent.id !== activeSession) return
    model.reportError(payload.error)
    tui.requestRender()
  }))

  disposers.push(ctx.on('agent/assistant-stream', payload => {
    if (payload.agent.id !== activeSession) return
    if (payload.frame.type !== 'chunk') return
    model.applyStreamChunk(payload.frame.chunk)
    tui.requestRender()
  }))

  /**
   * Restyle a running session when the reader's section changes.
   *
   * The settings document is hot-reloaded by the host, so a reader watching a
   * shade land never has to leave the session to see it — which is what makes
   * tuning one bearable instead of a restart per attempt. The event is
   * namespace-filtered: another surface's preferences are not our repaint.
   */
  disposers.push(ctx.on('settings/updated', ns => {
    if (String(ns) !== TUI_SETTINGS_NAMESPACE) return
    pendingSettingsProblem = undefined
    applyTheme()
    applyDisplay()
    // Both caches hold rows under the old table, so they have to be told the
    // table moved; a repaint alone would reuse what they already stored.
    markdown.invalidate()
    view.invalidate()
    if (pendingSettingsProblem !== undefined) {
      model.notice(`dsh-tui settings: ${pendingSettingsProblem}`)
      pendingSettingsProblem = undefined
    }
    tui.requestRender()
  }))

  const degraded = describeMissingOptional(probe)
  if (degraded !== undefined) model.notice(degraded)

  /**
   * Open the session this run was launched for.
   *
   * A bare `--resume` asks a question only the reader can answer, so the
   * picker runs before anything is created: the agent is then opened on the
   * chosen session rather than swapped afterwards, which would leave the first
   * one's turn half-started.
   */
  const boot = async (): Promise<void> => {
    if (!resolved.resumePicker) {
      await openAgent(resolved.sessionId, resolved.resume)
      return
    }
    const picked = await chooseSession()
    if (picked === undefined) {
      requestExit(0)
      return
    }
    await openAgent(picked, true)
  }

  /**
   * Take the screen, then open the session this run was launched for.
   *
   * A mode named on the command line is resolved FIRST: the alt screen swallows
   * the launcher's own error output, so a mode this roster does not offer has to
   * be answered while the shell still owns the terminal.
   */
  const start = async (): Promise<void> => {
    if (requestedPreset !== undefined && agentPresets !== undefined) {
      seat = (await agentPresets.resolve(requestedPreset)).id
    }
    // A named mode that disagrees with the one this session recorded is refused
    // here as well as at the open, because the alternate screen closes over
    // whatever was painted on it: the reader would see the failure, not the
    // reason. With a picker the session is not known yet, so it waits for one.
    if (!resolved.resumePicker) await presetFor(resolved.sessionId, resolved.resume, undefined)
    tui.start()
    terminal.write(windowTitle(process.cwd(), 'ready'))
    // A refused settings edit is only visible now that the surface owns the
    // screen; a bare stderr line would have been hidden behind it.
    if (pendingSettingsProblem !== undefined) {
      model.notice(`dsh-tui settings: ${pendingSettingsProblem}`)
      pendingSettingsProblem = undefined
    }
    await boot()
  }

  void start().catch((error: unknown) => {
    requestExit(1, error instanceof Error ? error.message : String(error))
  })
}
