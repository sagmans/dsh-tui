import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { type Component, type KeyId, ProcessTerminal, ScrollView, VStack, isKeyRelease, matchesKey } from '@earendil-works/pi-tui'
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
import { createPromptHistory } from './agent/prompt-history.ts'
import { createPresetRoster, parsePresetArgument, type PresetRoster, type PresetSummary } from './agent/presets.ts'
import { createToolPresenter } from './agent/present.ts'
import { forkPoint, type ForkEvent } from './agent/fork.ts'
import { PROFILE_NAME, resumeHint } from './identity.ts'
import { createStatusFacts } from './agent/status.ts'
import { ModelSwitch, createModelCatalog, parseModelArgument, readModelRouteKey, type ModelChoice, type ModelRoute } from './agent/model.ts'
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
import { cancelStep, quitStep } from './input/cancel.ts'
import { createCompletionProvider } from './input/completion.ts'
import { ghostSuffix } from './input/ghost.ts'
import { LOCAL_COMMANDS, classifySubmission, type Submission } from './input/submission.ts'
import { createDeferredNotice } from './settings-notice.ts'
import {
  ChordReader,
  DEFAULT_PREFIX_KEYS,
  DEFAULT_PREFIX_WINDOW_S,
  chordBindings,
  chordKeysLine,
  installKeybindings,
  surfaceKeysLine,
} from './input/keymap.ts'
import { defaultKeymap, hintKeys, surfaceBindings, type Keymap, type SurfaceActionId } from './input/actions.ts'
import { resolveConfig } from './config.ts'
import { FoldCursor } from './fold-cursor.ts'
import { createRestoreRegistry } from './terminal/restore.ts'
import { ExternalEditor } from './terminal/external-editor.ts'
import { WarningSafeTui } from './terminal/warning-screen.ts'
import { BELL, shouldRingBell } from './terminal/bell.ts'
import { clipboardSequence } from './terminal/clipboard.ts'
import { CLEAR_TITLE, windowTitle } from './terminal/title.ts'
import { sessionStartReason } from './herdr/state.ts'
import { createHerdrReporter } from './herdr/reporter.ts'
import { defaultExportFile, transcriptToText } from './export.ts'
import { createTheme, forwardEditorTheme, forwardMarkdownTheme, type TuiTheme } from './theme.ts'
import { detectColourMode, type ColourMode } from './theme-capability.ts'
import { defaultSettings, readScope, settingsProblemMessage, toOverrides, TUI_SETTINGS_NAMESPACE, TuiSettingsSchema, type MermaidMode, type TuiSettings } from './theme-settings.ts'
import { pendingPrompts } from './queue.ts'
import { renderThemeTable } from './theme-command.ts'
import { KEYMAP_LAYERS, keymapLayer, renderKeymap } from './keys-command.ts'
import { resetSequence } from './theme-tokens.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { formatTokens } from './tokens.ts'
import { TranscriptModel } from './transcript.ts'
import { WorkFold, describeTodos, planSelectedActive, planToggleLine, readPlanState, type PlanModeState } from './work.ts'
import { WorkDock } from './ui/dock.ts'
import { GateInputBar } from './ui/gate-input.ts'
import type { GhostBrush } from './ui/editor.ts'
import { HistoryPicker } from './ui/history-picker.ts'
import { PromptBar } from './ui/prompt.ts'
import { MarkdownRenderer } from './ui/markdown.ts'
import { createMermaidTransform } from './ui/mermaid.ts'
import {
  EffortPicker,
  ModelPicker,
  PROVIDER_DEFAULT_EFFORT_ID,
  PresetPicker,
  SessionPicker,
  effortChoices,
  type PickerAction,
  type PickerCard,
} from './ui/picker.ts'
import { QueueBar } from './ui/queue.ts'
import { StatusBar } from './ui/status.ts'
import { DEFAULT_VIEW_STATE, TranscriptView } from './ui/view.ts'
import { PromptStash } from './stash.ts'
import { confirmedClear, StashConfirmPicker, StashPicker } from './ui/stash-picker.ts'

export const name = 'tui'

/**
 * Services the surface cannot run without.
 *
 * `tools` is what lets a card read its tool's own render intent; a context that
 * has not injected it throws on the property read, which silently degraded
 * every card to a bare generic row.
 */
export const inject = ['agents', 'tools']

/** One second in the unit a chord window is scheduled in. */
const MS_PER_SECOND = 1000

/** What the back hint names when the reader has unbound the key it would advertise. */
const BACK_HINT_FALLBACK = 'ctrl+b'

/** What the reader presses to leave a view they did not open. */
const backHint = (map: Keymap): string => `${hintKeys(map, 'surface.back') || BACK_HINT_FALLBACK} returns to this session`

/** Stored sessions titled at once when the picker opens. */
const TITLE_CONCURRENCY = 4

/** How often the running-state clock repaints while a turn is open. */
const STATUS_TICK_MS = 1000

/** Reverse video for the cell the cursor occupies, so a ghost keeps the cursor visible. */
const GHOST_CURSOR_PREFIX = '\u001b[7m'


function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/** The preset registry, asked for a service the agent's own composition holds. */
interface ServiceFor {
  serviceFor(agent: unknown, name: string): unknown
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
  /**
   * A refused settings edit, kept until the surface can show it: stderr is
   * behind the alt screen, and the section is read on a schedule of its own.
   */
  const settingsNotice = createDeferredNotice()
  let current = createTheme(themeMode())
  const applyTheme = (section: TuiSettings): void => {
    current = createTheme(themeMode(), toOverrides(section))
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
   * How a reply's mermaid fences draw, seeded from the reader's section.
   *
   * The transform reads this per render instead of capturing it, because the
   * settings document is hot-reloaded and a session already on screen has to
   * follow the edit.
   */
  let mermaidMode: MermaidMode = defaultSettings().mermaid
  /** The keys that start a chord, and how long one waits; the settings document owns all of it. */
  let prefixKeys: readonly KeyId[] = DEFAULT_PREFIX_KEYS
  let prefixWindowMs = DEFAULT_PREFIX_WINDOW_S * MS_PER_SECOND
  /** Every action's keys in force; the settings document owns it and a press reads it live. */
  let keymap: Keymap = defaultKeymap()
  /** Whether prompts are recorded and offered, and the cap on how many; the settings document owns all three. */
  let historyEnabled = defaultSettings().history.enabled
  let historyGhost = defaultSettings().history.ghost
  let historyMaxEntries = defaultSettings().history.maxEntries
  /**
   * The chord between a prefix and the action that follows it.
   *
   * Built here, before the terminal exists, because the settings scope applies
   * first and has to be able to end a chord armed under the keymap it replaced.
   * The repaint the window also wants is late-bound: only a key press reaches
   * it, and no key can arrive before the surface has started.
   */
  const keyChord = new ChordReader(() => prefixKeys, () => chordBindings(keymap), () => prefixWindowMs, () => tui.requestRender())
  /**
   * Seed the display the reader configured.
   *
   * The key toggles nested calls for one session, but a settings edit is a
   * deliberate act, so it re-seeds and becomes the new starting point; the
   * mermaid mode has no key of its own and only ever comes from the document.
   */
  const applyDisplay = (section: TuiSettings): void => {
    viewState.expandSubCalls = section.subcalls === 'inline'
    mermaidMode = section.mermaid
    prefixKeys = section.prefixes
    prefixWindowMs = section.prefixWindow * MS_PER_SECOND
    keymap = section.keymap
    // Installed where the library reads it, so a remap lands on the next press
    // rather than at the next restart.
    installKeybindings(keymap)
    historyEnabled = section.history.enabled
    historyGhost = section.history.ghost
    historyMaxEntries = section.history.maxEntries
    // A chord armed under the keymap the reader just replaced is not their chord.
    keyChord.disarm()
  }
  /**
   * Read the reader's section once and apply everything it configures.
   *
   * One read per change, because a refused section is reported on the way past:
   * reading it once per field would show the reader the same refusal twice.
   */
  const applySettings = (): void => {
    const section = readSection()
    applyTheme(section)
    applyDisplay(section)
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
    // Registration parses the document against the schema, so a section the
    // schema itself refuses throws here — inside a fiber whose failure the
    // screen never shows. Reporting it through the same holder keeps a typo
    // from costing the reader every setting they wrote, silently.
    let scope: { get(): unknown }
    try {
      scope = settingsCtx.settings.register(TUI_SETTINGS_NAMESPACE, TuiSettingsSchema)
    } catch (error) {
      // Nothing registered means nothing to read, so the reader's switch cannot
      // be confirmed: recording stays off rather than falling back to on.
      historyEnabled = false
      settingsNotice.post(settingsProblemMessage(error) + ' · prompt history stays off until the section parses')
      return
    }
    readSection = () => readScope(scope, message => settingsNotice.post(message))
    applySettings()
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
  /**
   * The reader's prompt history: global across projects, recorded from every
   * submitted line, and offered back as they type. Built before the bar so its
   * first load cannot race the first suggestion.
   */
  const promptHistory = createPromptHistory({
    cap: () => historyMaxEntries,
    warn: message => {
      model.notice(message)
      tui.requestRender()
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
    enabled: () => historyEnabled && historyGhost && theme.color && theme.visible('editor.ghost'),
    suggestion: input => ghostSuffix({ entries: promptHistory.entries(), ...input }),
    paint: (text, cell) => {
      const styled = theme.style('editor.ghost', text)
      return cell === 'cursor' ? GHOST_CURSOR_PREFIX + styled + resetSequence() : styled
    },
  }
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
  const markdown = new MarkdownRenderer(theme.markdown, createMermaidTransform({ theme, mode: () => mermaidMode }))
  const restore = createRestoreRegistry()
  const terminal = new ProcessTerminal()
  const tui = new WarningSafeTui(terminal)
  /** Whether a child process owns the terminal, which is when nothing here may write to it. */
  let handedOver = false
  /** Whether the host has unloaded this surface, after which nothing may start it again. */
  let disposed = false
  /** An exit asked for while a child owned the terminal, run once the screen is ours again. */
  let deferredExit: { readonly code: number; readonly reason: string | undefined } | undefined
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
  /** A pick being vetted owns the list, not the keyboard: filtering stays live while its verdict is read. */
  let vetting = false
  const view = new TranscriptView(model, theme, markdown, {
    state: () => viewState,
    gate: () => pending?.gate.card(),
    picker: () => pendingPicker?.picker.card(),
    keys: () => keymap,
  })
  // The key map goes in before the bar exists, so no press can be read as the
  // send the library submits on by default. A settings document read after this
  // point installs over it, which is why the bar reads the map per press.
  installKeybindings(keymap)
  const editor = new GateInputBar(tui, theme.editor, () => keymap, ghostBrush)
  // Answers are written in the reader's own editor, which is why a question
  // borrows the bar instead of drawing a second one beside it.
  const promptBar = new PromptBar(editor)
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

  // The bank is built once the picker exists to answer for it, so the status
  // source is late-bound: the footer must not read a half-constructed stash.
  let stash: PromptStash | undefined

  const statusFacts = createStatusFacts(ctx, {
    sessionId: () => activeSession,
    activity: () => ({ running: turnOpen, startedAt: turnStartedAt }),
    override: () => modelSwitch.current(),
    home: process.env.HOME,
    chord: () => keyChord.hint(),
    // Read per paint rather than written into the marker the view left behind:
    // a hint stored with the transcript would keep naming the key of the day it
    // was written, and the reader may remap it with the row already on screen.
    back: () => (viewedSession === activeSession ? undefined : backHint(keymap)),
    stash: () => stash?.entryCount,
  })
  const statusBar = new StatusBar(statusFacts, theme)
  const dock = new WorkDock(() => work.state(), theme, () => jobs, () => roster.list())
  // The queue is read from the agent this terminal drives rather than from the
  // session on screen, because it sits on the editor that submits to that agent.
  const queuedPrompts = (): readonly string[] => pendingPrompts(ctx, liveSession(activeSession))
  const queue = new QueueBar(queuedPrompts, theme)
  // Only a running turn has anything to say over time, so the clock stops with it.
  const statusTicker: ReturnType<typeof setInterval> = setInterval(() => {
    if (turnOpen) tui.requestRender()
  }, STATUS_TICK_MS)
  disposers.push(() => clearInterval(statusTicker))
  // A window that outlived the surface would repaint a screen that is gone.
  disposers.push(() => keyChord.disarm())

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
    // Queued input earns rows only while something is waiting, and it gives
    // them up before the editor does: the bar being typed in outranks what is
    // waiting behind it.
    { component: queue, basis: 'auto', shrink: 2, minSize: 0 },
    { component: new VStack([{ component: promptBar, basis: 'auto', shrink: 1, minSize: 1 }]), basis: 'auto', shrink: 1, minSize: 0 },
    { component: statusBar, basis: 'auto', shrink: 0, minSize: 1 },
  ]))
  tui.setFocus(editor)

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
    clearInterval(statusTicker)
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
        if (sessionOpened) terminal.write(`\n${resumeHint(String(activeSession), PROFILE_NAME)}\n`)
        appExit(code)
      })
  }

  const openGate = (next: PendingGate): void => {
    pending = next
    // The card's own title names the decision, which is what a reader glancing
    // at a wall of panes needs in order to know which one to open.
    herdr.block(next.gate.card().title)
    // A gate owns the keyboard: the editor must not collect the decision keys.
    editor.disableSubmit = true
    tui.setFocus(null)
    // A question is answered in this editor, which the gate draws under the row
    // being answered, so the hardware cursor belongs to it while it is borrowed.
    // It is set after the focus is cleared, which unmarks the component it left.
    editor.focused = next.kind === 'question'
    tui.requestRender()
  }

  const closeGate = (): void => {
    pending = undefined
    herdr.unblock()
    editor.disableSubmit = false
    // The question is answered or skipped, so the reader gets their prompt back
    // in the bar they left it in.
    promptBar.giveBack()
    tui.setFocus(editor)
    tui.requestRender()
  }

  /**
   * Whether the bar holds anything the reader wrote.
   *
   * Whitespace counts: it is a character the editor holds, and a press that
   * clears it is the press the reader asked for. A paste counts expanded,
   * because a marker is content rather than an absence of it.
   */
  const barHasText = (): boolean => editor.getExpandedText() !== ''

  /**
   * What each key the surface answers itself does; false hands the press back.
   *
   * Keyed by the table's own ids, so a key added to {@link SURFACE_ACTIONS}
   * without a handler here fails to compile rather than doing nothing.
   */
  const surfaceActions: Readonly<Record<SurfaceActionId, () => boolean>> = {
    toolDetail: () => {
      viewState.expandCards = !viewState.expandCards
      tui.requestRender()
      return true
    },
    subCalls: () => {
      viewState.expandSubCalls = !viewState.expandSubCalls
      tui.requestRender()
      return true
    },
    reasoning: () => {
      viewState.expandReasoning = !viewState.expandReasoning
      tui.requestRender()
      return true
    },
    effort: () => {
      void openEffortPicker()
      return true
    },
    history: () => {
      void openHistoryPicker()
      return true
    },
    back: () => {
      if (viewedSession !== activeSession) void showAgentSession()
      return true
    },
    interrupt: () => {
      // In raw mode Ctrl+C never reaches the process as SIGINT, so the surface
      // decides what one press takes back — and a press with nothing left to
      // cancel is handed back rather than spent on leaving.
      const queued = queuedPrompts()
      const step = cancelStep({
        barHasText: barHasText(),
        queuedPrompts: queued.length,
        turnRunning: turnOpen,
        viewingChild: viewedSession !== activeSession,
      })
      switch (step) {
        case 'clear-editor':
          editor.setText('')
          tui.requestRender()
          return true
        case 'reclaim-queued':
          // The interrupt drops whatever the agent had not started, so the words
          // are read before it is stopped and handed back to the bar: a key that
          // means "stop" must not be the key that loses the reader's own prompts.
          agent?.interrupt()
          editor.setText(queued.join('\n'))
          model.notice(`interrupt requested · ${queued.length} queued ${queued.length === 1 ? 'prompt' : 'prompts'} back in the bar`)
          tui.requestRender()
          return true
        case 'interrupt-turn':
          agent?.interrupt()
          model.notice('interrupt requested')
          tui.requestRender()
          return true
        case 'leave-child-view':
          void showAgentSession()
          return true
        case 'hand-back':
          return false
      }
    },
    quit: () => {
      // The only key that leaves. Text in the bar keeps it for the editor, so
      // the library's delete forward is never taken from a reader who is editing.
      switch (quitStep({ barHasText: barHasText(), overlayOpen: tui.hasOverlay(), turnRunning: turnOpen })) {
        case 'cancel-then-quit':
          // An exit that waits on a tool call is not an exit, so the turn is
          // asked to stop and the leave does not wait for the answer.
          agent?.interrupt()
          requestExit(0)
          return true
        case 'quit':
          requestExit(0)
          return true
        case 'hand-back':
          return false
      }
    },
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
      const action = pendingPicker.picker.handleKey(data)
      if (action === undefined) {
        tui.requestRender()
        return { consume: true }
      }
      if (vetting) {
        // A refusal check must not take the keyboard with it: the reader keeps
        // filtering and can still leave, while a second pick waits for the
        // first verdict rather than racing it.
        if (action.kind === 'cancel') settlePicker(undefined)
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
    // A chord is the surface's second key: the prefix is consumed and the
    // footer names what may follow, while a key that finishes nothing is handed
    // on. Detail the reader asked for is always available, even mid-turn: the
    // collapsed view is a default, not the only state.
    const chorded = keyChord.handle(data)
    if (chorded !== undefined) {
      if (chorded.kind === 'action') runSubmission(chorded.binding.submission)
      tui.requestRender()
      return { consume: true }
    }
    for (const binding of surfaceBindings(keymap)) {
      if (!matchesKey(data, binding.key)) continue
      return surfaceActions[binding.action]() ? { consume: true } : undefined
    }
    return undefined
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
    const picked = await openPicker(new SessionPicker(sessions, () => titles, undefined, () => keymap), refuseReason)
    return picked === undefined ? undefined : SessionId(picked)
  }

  /** Give the keyboard back to the editor and answer whoever opened the picker. */
  const settlePicker = (id: string | undefined): void => {
    const settle = pendingPicker?.settle
    pendingPicker = undefined
    herdr.unblock()
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
      // A picker owns the keyboard exactly as a gate does: nothing moves until
      // the reader chooses, so it is the same kind of wait.
      herdr.block(picker.card().title)
      editor.disableSubmit = true
      tui.setFocus(null)
      tui.requestRender()
    })

  /**
   * Reverse search over recorded prompts, seeded with whatever is in the bar.
   *
   * A pick replaces the draft; a cancel leaves it exactly as it was, because the
   * list was opened to look rather than to lose what is already typed.
   */
  const openHistoryPicker = async (): Promise<void> => {
    if (!historyEnabled) {
      model.notice('prompt history is disabled in ' + TUI_SETTINGS_NAMESPACE + ' settings')
      tui.requestRender()
      return
    }
    if (promptHistory.entries().length === 0) {
      const blocked = promptHistory.blockedReason()
      model.notice(blocked === undefined ? 'no prompt history yet' : 'prompt history is unavailable: ' + blocked)
      tui.requestRender()
      return
    }
    // The expanded text is what the reader wrote; a large paste sits in the bar
    // as a marker, and seeding with it would filter out the prompt it came from.
    const picked = await openPicker(new HistoryPicker(() => promptHistory.entries(), editor.getExpandedText(), () => keymap))
    if (picked === undefined) return
    editor.setText(picked)
    tui.requestRender()
  }

  /** The roster as the picker paints it, refreshed when the picker opens. */
  let presetRows: readonly PresetSummary[] = []

  /** Choose the mode a session that has not started yet will run. */
  const askForPreset = async (currentId: string | undefined): Promise<string | undefined> => {
    if (agentPresets === undefined) return undefined
    presetRows = await agentPresets.list()
    return await openPicker(new PresetPicker(() => presetRows, () => currentId, () => keymap))
  }

  /**
   * The prompt bank for the session this surface drives.
   *
   * The surface owns the editor, the picker, and the notices, so the bank is
   * handed the few things it needs to reach them and nothing else: the commands
   * stay free of terminal state and are exercised without one in the tests.
   */
  stash = new PromptStash(
    {
      getEditorText: () => editor.getExpandedText(),
      setEditorText: text => {
        editor.setText(text)
        tui.requestRender()
      },
      // A question answers in this editor, so a draft written into a borrowed bar
      // would become somebody's answer instead of a parked prompt. An editor
      // holding the draft in another program owns it just as firmly: a pop that
      // landed then would be deleted from the bank and then overwritten.
      editorIsAvailable: () => !promptBar.isBorrowed() && !handedOver,
      notice: message => model.notice(message),
      pick: (entries, label) => openPicker(new StashPicker(entries, label, () => keymap)),
      confirm: async count => confirmedClear(await openPicker(new StashConfirmPicker(count, () => keymap))),
      render: () => tui.requestRender(),
    },
    // The bank follows the session this surface drives, not the directory it
    // runs in: two terminals in one checkout keep separate drafts, and a resume
    // finds the ones it parked. Read per command so a switch retargets it.
    { sessionId: () => String(activeSession) },
  )

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
      writeTerminal(windowTitle(process.cwd(), turnOpen ? 'working' : 'ready'))
    },
    notice: message => model.notice(message),
  })

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
    model.marker(returned ? 'back to the session this terminal drives' : `viewing ${id}`)
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
    // The bank follows the session, so the footer stops counting the drafts of
    // the session just left and the next command reads this session's file.
    void stash?.open()
    // The agent's own id is reported rather than the requested one: a resume can
    // be answered by the session the log actually holds.
    herdr.session({
      id: String(handle.sessionId),
      cwd: process.cwd(),
      reason: sessionStartReason({ forked: fork !== undefined, resumed: resume }),
    })
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
      case 'current':
        // Choosing by eye is the point of a terminal selector; the picker
        // heads itself with the route the next step will actually use.
        void openModelPicker()
        return
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

  /** Whether a model picker's catalog is being read, so a second key cannot race it. */
  let openingModels = false

  /** One route, as the picker names it; the effort is not part of the choice here. */
  type PickedRoute = { readonly provider: string; readonly model: string }

  /**
   * The route the next step would actually use.
   *
   * Without a choice of its own the surface reports the composition default,
   * not that it has no opinion: the picker's heading and its marked row have to
   * agree with the status line about the route in force.
   */
  const effectiveRoute = (): ModelChoice | undefined => {
    const chosen = modelSwitch.current()
    if (chosen !== undefined) return chosen
    const facts = statusFacts()
    if (facts.provider === undefined || facts.model === undefined) return undefined
    return {
      provider: facts.provider,
      model: facts.model,
      ...facts.effort === undefined ? {} : { reasoningEffort: facts.effort },
    }
  }

  /** Put the reader's route choice in force for the next step. */
  const applyRoute = (route: PickedRoute): void => {
    const current = effectiveRoute()
    // The levels belong to the route, so a switch clears an explicit effort
    // while re-picking the route already in force is not a switch.
    const keep = current !== undefined && current.provider === route.provider && current.model === route.model
      ? current.reasoningEffort
      : undefined
    modelSwitch.choose({
      provider: route.provider,
      model: route.model,
      ...keep === undefined ? {} : { reasoningEffort: keep },
    })
    model.notice(`model set to ${route.provider}/${route.model} for the next step`)
    tui.requestRender()
  }

  /**
   * Offer the levels a route advertises, after the route is already in force.
   *
   * Cancelling the list is a real choice — the reader keeps the model with the
   * provider's own default — which is why the route is applied first. The list
   * is read before the picker opens because the rows are the route's own
   * metadata; a menu painted before that arrived could offer a level the
   * request would then be refused for.
   */
  const offerRouteEfforts = async (route: PickedRoute): Promise<void> => {
    if (catalog === undefined) return
    try {
      const info = await catalog.efforts(route.provider, route.model)
      const efforts = info?.efforts ?? []
      if (efforts.length === 0) return
      const current = effectiveRoute()
      const effective = current !== undefined && current.provider === route.provider && current.model === route.model
        ? current.reasoningEffort
        : undefined
      const picked = await openPicker(new EffortPicker(
        () => effortChoices(efforts, effective),
        `reasoning effort · ${route.provider}/${route.model}`,
        () => keymap,
      ))
      if (picked !== undefined) applyEffort(route.provider, route.model, picked)
    } catch (error) {
      model.notice(`could not read reasoning efforts: ${error instanceof Error ? error.message : String(error)}`)
    }
    tui.requestRender()
  }

  /**
   * Offer every model the configured routes advertise.
   *
   * Rows come from the routes the llm service registered — the providers this
   * deployment configured — and each provider's models join the open list as
   * its catalog resolves, so the picker is filterable before the slowest
   * adapter answers. A route whose catalog cannot be read stays reachable by
   * name through the text form rather than by an explanation in the list.
   */
  const openModelPicker = async (): Promise<void> => {
    if (catalog === undefined) {
      model.notice('this profile has no llm service, so models cannot be listed or switched')
      tui.requestRender()
      return
    }
    const providers = catalog.providers()
    if (providers.length === 0) {
      model.notice('no provider is configured; add one before choosing a model')
      tui.requestRender()
      return
    }
    if (openingModels) return
    openingModels = true
    try {
      const routes: ModelRoute[] = []
      for (const provider of providers) {
        void catalog.models(provider.id).then(entries => {
          if (entries.length === 0) return
          routes.push(...entries.map(entry => ({ provider: provider.id, model: entry.id, name: entry.name })))
          tui.requestRender()
        }).catch(() => {
          // One adapter's discovery failure is not the list's to explain.
        })
      }
      const picked = await openPicker(new ModelPicker(() => routes, effectiveRoute, () => keymap))
      if (picked === undefined) return
      const route = readModelRouteKey(picked)
      if (route === undefined) return
      applyRoute(route)
      await offerRouteEfforts(route)
    } finally {
      openingModels = false
      tui.requestRender()
    }
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
        () => keymap,
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
    return `commands: ${commands} · surface: ${LOCAL_COMMANDS.join(' ')} · keys: ${surfaceKeysLine(keymap)} · ${chordKeysLine(keymap)}`
  }

  /**
   * Whether the agent this surface is driving is in plan mode.
   *
   * The dock's fold is the fallback, for a composition without the plan
   * package: with the controller present its answer is the agent's own state
   * rather than a replay of the events this surface happened to see.
   */
  const planState = (): PlanModeState | undefined => {
    const current = agent?.agent
    if (current === undefined) return undefined
    const presets = ctx.get('agentPresets') as ServiceFor | undefined
    return readPlanState({
      direct: name => ctx.get(name),
      forAgent: (target, name) => presets?.serviceFor(target, name),
    }, current)
  }

  const planActive = (): boolean => planSelectedActive(planState(), work.state().planMode)

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

  /** Show where history is kept, or forget it; the file is global to this machine. */
  const runHistoryCommand = (argument: string): void => {
    // The line that asked for this is recorded before the command runs, but that
    // write rides the store's queue; waiting for it lets the count describe the
    // file the reader has, not the state before their own line landed.
    void promptHistory.flush().then(() => {
      if (argument === '') {
        const count = promptHistory.entries().length
        const blocked = promptHistory.blockedReason()
        model.notice([
          count + (count === 1 ? ' prompt recorded' : ' prompts recorded'),
          promptHistory.path(),
          blocked === undefined ? undefined : 'writes disabled: ' + blocked,
        ].filter(part => part !== undefined).join(' · '))
        tui.requestRender()
        return
      }
      if (argument !== 'clear') {
        model.notice('usage: /history shows where history is kept · /history clear forgets every prompt')
        tui.requestRender()
        return
      }
      // A refused write cannot remove anything, so saying "forgot 0 prompts"
      // would describe a successful clear the file never had.
      const blocked = promptHistory.blockedReason()
      if (blocked !== undefined) {
        model.notice('prompt history is unavailable: ' + blocked)
        tui.requestRender()
        return
      }
      return promptHistory.clear().then(removed => {
        model.notice('forgot ' + removed + (removed === 1 ? ' prompt' : ' prompts'))
        tui.requestRender()
      })
    }).catch(error => {
      // The store keeps what the file still holds, so the reader is told the
      // clear failed rather than being shown a count that never landed.
      model.notice('could not clear prompt history: ' + (error instanceof Error ? error.message : String(error)))
      tui.requestRender()
    })
  }

  /**
   * Carry out one classified line, wherever it was asked for.
   *
   * A chord asks for the same things the command line does, so both arrive
   * here: a chord cannot behave differently from the command it stands for.
   */
  const runSubmission = (submission: Submission): void => {
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
      case 'keys': {
        const layer = submission.argument === '' ? undefined : keymapLayer(submission.argument)
        if (submission.argument !== '' && layer === undefined) {
          model.notice(`unknown layer "${submission.argument}" · ${KEYMAP_LAYERS.join(' ')}`)
        } else {
          for (const line of renderKeymap(keymap, layer)) model.notice(line)
        }
        tui.requestRender()
        return
      }
      case 'copy':
        runCopyCommand()
        return
      case 'history':
        runHistoryCommand(submission.argument)
        return
      case 'stash':
        // Submitting a command consumes the line it was typed on, so this path
        // can only carry a draft it was given; parking the bar's own draft is
        // what the chord is for.
        if (submission.argument.trim() === '') model.notice('usage: /stash <draft>, or ctrl+x then s to park the editor')
        else void stash?.stashEditor(submission.argument)
        return
      case 'stash-draft':
        void stash?.stashEditor()
        return
      case 'stash-pop':
        void stash?.pop(submission.selector)
        return
      case 'stash-apply':
        void stash?.apply(submission.selector)
        return
      case 'stash-list':
        void stash?.list(String(activeSession))
        return
      case 'stash-drop':
        void stash?.drop(submission.selector)
        return
      case 'stash-clear':
        void stash?.clear()
        return
      case 'editor':
        void externalEditor.edit(editor.getExpandedText()).then(text => {
          if (text !== undefined) {
            // A gate can open while the child owns the screen, and the bar then
            // holds somebody's answer: the edited draft waits behind it instead
            // of being written into a question the reader never answered.
            if (promptBar.isBorrowed()) promptBar.replaceHeld(text)
            else editor.setText(text)
            tui.requestRender()
          }
          const pendingExit = deferredExit
          deferredExit = undefined
          if (pendingExit !== undefined) requestExit(pendingExit.code, pendingExit.reason)
        })
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
      // Plan mode is a command the harness owns, so the chord asks the host for
      // the state and names the command for the other one: one key, both ways.
      case 'plan':
        runCommand('plan', planToggleLine(planActive()))
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

  editor.onSubmit = text => {
    const submission = classifySubmission(text)
    if (submission.kind === 'empty') return
    // The library's own history feeds the up/down keys; the store below feeds
    // ghost completion and reverse search, and is global rather than per-session.
    editor.addToHistory(text)
    if (historyEnabled) promptHistory.record(text)
    runSubmission(submission)
  }

  disposers.push(ctx.on('session/event', (session, event) => {
    // The surface state — activity, timer, title, bell, job board — belongs to
    // the agent this terminal drives, even while a child is on screen.
    if (session.id === activeSession) {
      if (event.type === 'turn/start') {
        turnOpen = true
        turnStartedAt = Date.now()
        writeTerminal(windowTitle(process.cwd(), 'working'))
        herdr.working()
      }
      if (event.type === 'turn/end') {
        const ranFor = turnStartedAt === undefined ? 0 : Date.now() - turnStartedAt
        turnOpen = false
        turnStartedAt = undefined
        writeTerminal(windowTitle(process.cwd(), 'ready'))
        herdr.idle()
        if (shouldRingBell({ bell: resolved.bell, ranForMs: ranFor, exiting: exited })) writeTerminal(BELL)
        // A job the turn started may have settled while the reader was watching
        // something else, and nothing else refreshes a live board.
        refreshJobs()
      }
      // A claim or a discard changes what is queued, and that belongs to this
      // session even while the transcript shows a child's conversation.
      if (event.type === 'agent/inbox/spliced') tui.requestRender()
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
      const gate = new ApprovalGate(request.toolName, request.reason, () => keymap)
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
      const gate = promptBar.borrow(() => new QuestionGate(questions, editor, () => keymap))
      // The seam takes mutable selection arrays and an optional custom field, so
      // the read-only gate answer is copied into that exact shape here.
      const settle = (answers: GateAnswer[]): void => {
        request.signal?.removeEventListener('abort', onAbort)
        resolve({
          answers: answers.map(answer => ({
            id: answer.id,
            selected: [...answer.selected],
            ...(answer.custom === undefined ? {} : { custom: answer.custom }),
          })),
        })
      }
      // A question whose caller is gone has no reader, so the gate must release
      // the keyboard instead of collecting an answer the aborted call discards.
      const onAbort = (): void => {
        gate.cancel()
        if (pending?.gate === gate) closeGate()
        settle([])
      }
      openGate({ kind: 'question', gate, settle })
      request.signal?.addEventListener('abort', onAbort, { once: true })
      // A signal that aborted before the listener existed never emits, so the
      // state has to be read once after subscribing.
      if (request.signal?.aborted === true) onAbort()
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
    applySettings()
    // Both caches hold rows under the old table, so they have to be told the
    // table moved; a repaint alone would reuse what they already stored.
    markdown.invalidate()
    view.invalidate()
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
    writeTerminal(windowTitle(process.cwd(), 'ready'))
    // Claiming the pane's agent row does not wait for a session: the pane is
    // already on screen and already idle, and a session may still be chosen.
    herdr.publish()
    // A refused settings edit is only visible now that the surface owns the
    // screen; whatever the scope found before this point prints here instead.
    settingsNotice.open(message => model.notice(message))
    await boot()
  }

  void start().catch((error: unknown) => {
    requestExit(1, error instanceof Error ? error.message : String(error))
  })
}
