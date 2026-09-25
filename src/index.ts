import { type Component, ScrollView } from '@earendil-works/pi-tui'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createSessionHistory, presetOfStoredSession } from './agent/history.ts'
import { createPresetRoster } from './agent/presets.ts'
import type { ForkEvent } from './agent/fork.ts'
import { createStatusFacts } from './agent/status.ts'
import { describeMissingOptional, describeMissingRequired, probeComposition } from './compat/probe.ts'
import { hasLiveRowSettings, readRowSettings, resolveConfig } from './config.ts'
export { Config } from './config.ts'
import { windowTitle } from './terminal/title.ts'
import { toolDisplayFor } from './tool-display.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createAppearance } from './surface/appearance.ts'
import { createBackgroundWork } from './surface/background-work.ts'
import { createCommands } from './surface/commands.ts'
import { createModalInput } from './surface/modal-input.ts'
import { createModelChoice } from './surface/model-choice.ts'
import { createPromptInput } from './surface/prompt-input.ts'
import { createPromptMemory } from './surface/prompt-memory.ts'
import { createPresetChoice } from './surface/preset-choice.ts'
import { createSessionLifecycle } from './surface/session-lifecycle.ts'
import { backHint, createSessionView } from './surface/session-view.ts'
import { createStagedTurns } from './surface/staged-turns.ts'
import { createTerminalLifecycle } from './surface/terminal-lifecycle.ts'
import { WorkDock } from './ui/dock.ts'
import { GateInputBar } from './ui/gate-input.ts'
import { surfaceLayout } from './ui/layout.ts'
import { PromptBar } from './ui/prompt.ts'
import { MarkdownRenderer } from './ui/markdown.ts'
import { createMermaidTransform } from './ui/mermaid.ts'
import { QueueBar } from './ui/queue.ts'
import { StatusBar } from './ui/status.ts'
import { TranscriptView } from './ui/view.ts'
import type { PromptStash } from './stash.ts'

export const name = 'tui'

/**
 * Services the surface cannot run without.
 *
 * `tools` is what lets a card read its tool's own render intent; a context that
 * has not injected it throws on the property read, which silently degraded
 * every card to a bare generic row.
 */
export const inject = ['agents', 'tools']

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
   * The reader's appearance, built first because everything this surface draws
   * holds its theme delegate and reads its preferences live.
   *
   * The settings scope is registered further down, because it re-seeds the prompt
   * bar's own keys and may only apply once that owner exists.
   */
  const appearance = createAppearance(ctx, {
    color: () => resolved.color,
    // The row's own theme is the layer a profile patch can pin on a harness
    // that keeps settings per row, so it is read here beside the section.
    rowTheme: resolved.theme,
    rowSettings: () => readRowSettings(config),
    rowSettingsLive: hasLiveRowSettings(config),
    notice: message => sessionView.notice(message),
    render: () => tui.requestRender(),
    invalidateMarkdown: () => markdown.invalidate(),
    invalidateView: () => view.invalidate(),
    // The chord a settings edit has to end is armed in the bar's own owner, so it
    // is reached through the thing that holds it rather than copied here.
    keybindings: () => promptInput,
    openPicker: picker => modalInput.openPicker(picker),
  })
  const { theme } = appearance
  /**
   * The prompt bar's own presses, built here rather than beside the bar.
   *
   * The settings scope below applies first and has to be able to end a chord
   * armed under the keymap it replaced, so this owner exists before the terminal
   * or the editor do; each port reads them at call time for that reason.
   */
  const promptInput = createPromptInput(ctx, {
    keymap: appearance.keymap,
    prefixKeys: appearance.prefixKeys,
    prefixWindowMs: appearance.prefixWindowMs,
    tui: () => tui,
    editor: () => editor,
    promptBar: () => promptBar,
    modalHandleKey: data => modalInput.handleKey(data),
    toggleCards: appearance.toggleCards,
    toggleSubCalls: appearance.toggleSubCalls,
    toggleReasoning: appearance.toggleReasoning,
    openEffortPicker: () => {
      void modelChoice.openEffortPicker()
    },
    openHistoryPicker: () => {
      void promptMemory.openHistoryPicker()
    },
    back: () => {
      if (sessionView.viewingChild()) void sessionView.showDriven()
    },
    queuedPrompts: () => sessionLifecycle.queuedPrompts(),
    turnRunning: () => sessionLifecycle.turnRunning(),
    viewingChild: () => sessionView.viewingChild(),
    interrupt: () => {
      sessionLifecycle.drivingAgent()?.interrupt()
    },
    notice: message => sessionView.notice(message),
    requestExit: code => requestExit(code),
    recordPrompt: text => promptMemory.record(text),
    runSubmission: submission => commands.runSubmission(submission),
    drivenAgent: () => sessionLifecycle.drivingAgent()?.agent,
    registeredCommands: target => commands.registeredCommands(target),
  })
  appearance.registerSection()

  /**
   * The transcript on screen, and the fold that feeds it.
   *
   * Built before anything that draws it, and before the session it opens on is
   * driven: every read it takes of the driven identity, the staged cutoff, and
   * the render target is a port taken at call time, because all three move as
   * the reader switches sessions.
   */
  const sessionView = createSessionView(ctx, {
    initialSession: resolved.sessionId,
    drivenSession: () => sessionLifecycle.activeSession(),
    stagedCutoff: () => stagedTurns.stagedCutoff(),
    agentScope: id => ctx.agents?.get(id),
    liveEvents: id => liveSession(id)?.snapshotEvents?.(),
    render: () => tui.requestRender(),
  })
  /**
   * The prompt's own memory, constructed where the box that draws its ghost
   * already exists; the settings readers stay live because the document is
   * hot-reloaded.
   */
  const promptMemory = createPromptMemory({
    historyEnabled: appearance.historyEnabled,
    historyGhost: appearance.historyGhost,
    historyMaxEntries: appearance.historyMaxEntries,
    theme,
    keymap: appearance.keymap,
    notice: message => sessionView.notice(message),
    render: () => tui.requestRender(),
    editorText: () => editor.getExpandedText(),
    setEditorText: text => {
      editor.setText(text)
      tui.requestRender()
    },
    // A question answers in this editor, so a draft written into a borrowed bar
    // would become somebody's answer instead of a parked prompt. An editor
    // holding the draft in another program owns it just as firmly: a pop that
    // landed then would be deleted from the bank and then overwritten.
    editorAvailable: () => !promptBar.isBorrowed() && !terminalLifecycle.handedOver(),
    activeSession: () => sessionLifecycle.activeSession(),
    // The keyboard's lifetime is the modal owner's, so the list is handed over
    // rather than driven here.
    openPicker: picker => modalInput.openPicker(picker),
  })
  const ghostBrush = promptMemory.ghostBrush
  /**
   * The route this session runs with, built before the status facts that report
   * it and read through ports because the screen, the keyboard and the settings
   * document that supplies the default all belong to the surface around it.
   */
  const modelChoice = createModelChoice(ctx, {
    statusFacts: () => statusFacts(),
    keymap: appearance.keymap,
    openPicker: picker => modalInput.openPicker(picker),
    notice: message => sessionView.notice(message),
    render: () => tui.requestRender(),
  })
  const agentPresets = createPresetRoster(ctx)
  /**
   * Which mode a session takes, read through ports because the open path mounts
   * through the same roster and the screen, the keyboard, the notice, and the
   * session the reader watches all belong to the surface around it.
   */
  const presetChoice = createPresetChoice({
    agentPresets,
    requestedPreset: resolved.preset,
    // The mode a session ran is a property of its own log, which is the same
    // history this surface lists the stored sessions from.
    storedPreset: async id => {
      const history = createSessionHistory(ctx)
      return history === undefined ? undefined : await presetOfStoredSession(history, id)
    },
    livePreset: id => agentPresets?.current(liveSession(id)),
    drivingAgent: () => sessionLifecycle.drivingAgent(),
    keymap: appearance.keymap,
    openPicker: picker => modalInput.openPicker(picker),
    notice: message => sessionView.notice(message),
    render: () => tui.requestRender(),
    returnToDrivenSession: async () => {
      if (sessionView.viewingChild()) await sessionView.show(sessionLifecycle.activeSession())
    },
  })
  const backgroundWork = createBackgroundWork(ctx, {
    drivingAgent: () => sessionLifecycle.drivingAgent(),
    activeSession: () => sessionLifecycle.activeSession(),
    notice: text => sessionView.notice(text),
    marker: text => sessionView.marker(text),
    render: () => tui.requestRender(),
    navigate: id => {
      void sessionView.show(SessionId(id))
    },
  })
  const markdown = new MarkdownRenderer(theme.markdown, createMermaidTransform({ theme, mode: () => appearance.mermaidMode() }))
  const terminalLifecycle = createTerminalLifecycle(ctx, {
    reportFrameError: error => sessionView.reportError(error),
    notice: message => sessionView.notice(message),
    copyRows: () => view.copyRows(),
    activeSession: () => sessionLifecycle.activeSession(),
    sessionOpened: () => sessionLifecycle.sessionOpened(),
    turnRunning: () => sessionLifecycle.turnRunning(),
    stopClock: () => sessionLifecycle.stopClock(),
    exit: appExit,
    draftText: () => editor.getExpandedText(),
    draftBorrowed: () => promptBar.isBorrowed(),
    holdDraft: text => promptBar.replaceHeld(text),
    writeDraft: text => editor.setText(text),
  })
  const { terminal, tui, herdr, disposers, writeTerminal, requestExit, exited } = terminalLifecycle

  const view = new TranscriptView(sessionView.model, theme, markdown, {
    state: appearance.viewState,
    gate: () => modalInput.gateCard(),
    picker: () => modalInput.pickerCard(),
    keys: appearance.keymap,
    toolDisplay: tool => toolDisplayFor(appearance.toolDisplay(), tool),
  })
  // The key map goes in before the bar exists, so no press can be read as the
  // send the library submits on by default. A settings document read after this
  // point installs over it, which is why the bar reads the map per press.
  promptInput.installBindings()
  const editor = new GateInputBar(tui, theme.editor, appearance.keymap, ghostBrush)
  // Answers are written in the reader's own editor, which is why a question
  // borrows the bar instead of drawing a second one beside it.
  const promptBar = new PromptBar(editor)

  /**
   * The one modal interaction at a time, and the keyboard it holds.
   *
   * Built before the transcript view so the view can ask it for a card: the
   * card a gate or picker draws is read per paint, never copied.
   */
  const modalInput = createModalInput(ctx, {
    herdr,
    editor,
    tui,
    terminal,
    theme,
    keymap: appearance.keymap,
    promptBar,
    refreshCompletion: () => promptInput.applyCompletion(),
    activeSession: () => sessionLifecycle.activeSession(),
  })
  disposers.push(sessionView.clearPresentScope)
  /**
   * The staged cursor over the session this terminal drives, and the prompts
   * parked behind it.
   *
   * Every port is read at call time — the agent, the session, the draft, the
   * queue all move while an undo settles an interrupt — so this owner can exist
   * before the agent it replaces does.
   */
  const stagedTurns = createStagedTurns({
    viewingChild: () => sessionView.viewingChild(),
    activeSession: () => sessionLifecycle.activeSession(),
    sessionEvents: id => sessionView.sessionEvents(id),
    resetTranscript: () => sessionView.reset(),
    foldTranscript: (id, cutoff) => sessionView.fold(id, cutoff),
    drivingAgent: () => sessionLifecycle.drivingAgent(),
    disposeOutgoing: () => sessionLifecycle.disposeOutgoing(),
    openSession: (id, resume, fork) => sessionLifecycle.openAgent(id, resume, fork),
    queuedPrompts: () => sessionLifecycle.queuedPrompts(),
    canPark: () => stash !== undefined,
    parkPrompt: text => stash?.stashEditor(text) ?? Promise.resolve(),
    turnRunning: () => sessionLifecycle.turnRunning(),
    draft: () => editor.getExpandedText(),
    writeDraft: text => editor.setText(text),
    notice: message => sessionView.notice(message),
    render: () => tui.requestRender(),
  })
  // The bank is built once the picker exists to answer for it, so the status
  // source is late-bound: the footer must not read a half-constructed stash.
  let stash: PromptStash | undefined

  const statusFacts = createStatusFacts(ctx, {
    sessionId: () => sessionLifecycle.activeSession(),
    activity: () => sessionLifecycle.activity(),
    override: () => modelChoice.current(),
    home: process.env.HOME,
    chord: () => promptInput.chordHint(),
    // Read per paint rather than written into the marker the view left behind:
    // a hint stored with the transcript would keep naming the key of the day it
    // was written, and the reader may remap it with the row already on screen.
    back: () => (sessionView.viewingChild() ? backHint(appearance.keymap()) : undefined),
    stash: () => stash?.entryCount,
  })
  const statusBar = new StatusBar(statusFacts, theme)
  const dock = new WorkDock(() => sessionView.workState(), theme, () => backgroundWork.jobs(), () => backgroundWork.roster.list(), undefined, id => {
    void sessionView.show(SessionId(id))
  })
  const queue = new QueueBar(() => sessionLifecycle.queuedPrompts(), theme)
  /**
   * The agent this terminal drives, and the clock that repaints it while a turn
   * is open.
   *
   * Built after the widgets that draw it and before the layout that mounts them,
   * and every port is read at call time: the readers above exist before this
   * owner does, and the session it drives moves under them.
   */
  const sessionLifecycle = createSessionLifecycle(ctx, {
    initialSession: resolved.sessionId,
    model: resolved.model,
    provider: resolved.provider,
    bell: resolved.bell,
    presetFor: (id, resume, fork) => presetChoice.presetFor(id, resume, fork),
    installModelChoice: agentCtx => modelChoice.setup(agentCtx),
    mountPreset: async (agentCtx, preset) => {
      await agentPresets?.mount(agentCtx, preset)
    },
    liveSession: id => liveSession(id),
    installCompletion: () => promptInput.installCompletion(),
    sessionEvents: id => sessionView.sessionEvents(id),
    setViewed: id => sessionView.setViewed(id),
    setPresentScope: scope => sessionView.setPresentScope(scope),
    clearPresentScope: sessionView.clearPresentScope,
    resetTranscript: () => sessionView.reset(),
    replay: id => sessionView.replay(id),
    fold: id => sessionView.fold(id),
    notice: message => sessionView.notice(message),
    render: () => tui.requestRender(),
    promptMemorySessionOpened: () => promptMemory.sessionOpened(),
    stagedSessionOpened: id => stagedTurns.sessionOpened(id),
    turnSettled: () => stagedTurns.turnSettled(),
    acceptCatalog: info => backgroundWork.acceptCatalog(info),
    resetRoster: () => backgroundWork.resetRoster(),
    refreshJobs: () => backgroundWork.refresh(),
    herdr,
    writeTerminal,
    exiting: exited,
    disposers,
  })
  // A window that outlived the surface would repaint a screen that is gone.
  disposers.push(() => promptInput.disarmChord())
  // Registered here rather than inside the terminal owner: this is the position
  // the one teardown list gave the signal seam before the surface was split.
  disposers.push(terminalLifecycle.signalShutdown())

  tui.setLayoutRoot(surfaceLayout({
    transcript: new ScrollView(view, { follow: 'end', primary: true, overscroll: 'chain' }),
    dock,
    queue,
    prompt: promptBar,
    status: statusBar,
  }))
  tui.setFocus(editor)

  disposers.push(promptInput.inputListener())

  stash = promptMemory.buildStash()

  /**
   * The command plane, wired to the owners every submission is delegated to.
   *
   * Built once the bank exists, because the parked-draft commands route to the
   * very bank the footer counts; every other port is a live read, so a command
   * typed after a session switch answers for the session now on screen.
   */
  const commands = createCommands(ctx, {
    launch: {
      sessionId: resolved.sessionId,
      resume: resolved.resume,
      resumePicker: resolved.resumePicker,
    },
    preset: resolved.preset,
    presetRoster: agentPresets,
    missingOptional: () => describeMissingOptional(probe),
    session: sessionLifecycle,
    transcript: sessionView,
    route: modelChoice,
    modes: presetChoice,
    work: backgroundWork,
    staged: stagedTurns,
    memory: promptMemory,
    appearance,
    terminal: terminalLifecycle,
    modals: modalInput,
    statusFacts: () => statusFacts(),
    stash: () => stash,
    render: () => tui.requestRender(),
  })

  /** The live session this process runs, which is the only source holding an unflushed tail. */
  const liveSession = (id: SessionId): { snapshotEvents?: () => readonly ForkEvent[] } | undefined =>
    (ctx.get('sessions') as { get?: (id: SessionId) => { snapshotEvents?: () => readonly ForkEvent[] } | undefined } | undefined)?.get?.(id)

  promptInput.attachSubmit()

  disposers.push(ctx.on('session/event', (session, event) => {
    sessionLifecycle.observe(session, event)
    sessionView.observe(session.id, event)
  }))

  disposers.push(...sessionLifecycle.driverListeners())

  disposers.push(...backgroundWork.subagentListeners())

  disposers.push(...modalInput.requestListeners())

  disposers.push(...promptInput.commandListeners())

  // The board is live state: watch it directly rather than folding events.
  disposers.push(backgroundWork.watchJobs())

  disposers.push(...sessionView.agentListeners())

  disposers.push(appearance.settingsListener())

  appearance.createThemesHome()
  disposers.push(appearance.watchThemes())

  void commands.start().catch((error: unknown) => {
    requestExit(1, error instanceof Error ? error.message : String(error))
  })
}
