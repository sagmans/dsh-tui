import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { type Component, ScrollView } from '@earendil-works/pi-tui'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createSessionHistory, presetOfStoredSession } from './agent/history.ts'
import { createPresetRoster } from './agent/presets.ts'
import type { ForkEvent } from './agent/fork.ts'
import { createStatusFacts } from './agent/status.ts'
import { describeMissingOptional, describeMissingRequired, probeComposition } from './compat/probe.ts'
import { LOCAL_COMMANDS, type Submission } from './input/submission.ts'
import { chordKeysLine, surfaceKeysLine } from './input/keymap.ts'
import { type ActionLayer, type SurfaceActionId } from './input/action-catalog.ts'
import { resolveConfig } from './config.ts'
import { clipboardSequence } from './terminal/clipboard.ts'
import { windowTitle } from './terminal/title.ts'
import { defaultExportFile, transcriptToText } from './export.ts'
import { toolDisplayFor } from './tool-display.ts'
import { KEYMAP_LAYERS, keymapLayer } from './keys-command.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createAppearance } from './surface/appearance.ts'
import { createBackgroundWork } from './surface/background-work.ts'
import { createModalInput } from './surface/modal-input.ts'
import { createModelChoice } from './surface/model-choice.ts'
import { createPromptInput } from './surface/prompt-input.ts'
import { createPromptMemory } from './surface/prompt-memory.ts'
import { createPresetChoice } from './surface/preset-choice.ts'
import { createSessionLifecycle } from './surface/session-lifecycle.ts'
import { createSessionPicker } from './surface/session-picker.ts'
import { backHint, createSessionView } from './surface/session-view.ts'
import { createStagedTurns } from './surface/staged-turns.ts'
import { createTerminalLifecycle } from './surface/terminal-lifecycle.ts'
import { formatTokens } from './tokens.ts'
import { describeTodos, planSelectedActive, planToggleLine, readPlanState, type PlanModeState } from './work.ts'
import { WorkDock } from './ui/dock.ts'
import { GateInputBar } from './ui/gate-input.ts'
import { surfaceLayout } from './ui/layout.ts'
import { KeymapPicker } from './ui/keymap-picker.ts'
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
    runSubmission: submission => runSubmission(submission),
    drivenAgent: () => sessionLifecycle.drivingAgent()?.agent,
    registeredCommands: target => registry()?.list(target),
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
  const { terminal, tui, herdr, disposers, writeTerminal, requestExit, editDraft, exited } = terminalLifecycle

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

  tui.setLayoutRoot(surfaceLayout({
    transcript: new ScrollView(view, { follow: 'end', primary: true, overscroll: 'chain' }),
    dock,
    queue,
    prompt: promptBar,
    status: statusBar,
  }))
  tui.setFocus(editor)

  disposers.push(promptInput.inputListener())

  const registry = (): CommandRegistry | undefined => ctx.get('commands') as CommandRegistry | undefined

  /**
   * Where a bare `--resume` gets its list, and the ports it drives.
   *
   * The keyboard is taken through a port rather than here: how a picker holds
   * it, and how long it may, is the modal owner's business.
   */
  const sessionPicker = createSessionPicker(ctx, {
    keymap: appearance.keymap,
    notice: message => sessionView.notice(message),
    render: () => tui.requestRender(),
    // A stored session's own mode can only disagree with one this run named, and
    // only a roster can say whether the name it uses still exists.
    validateStoredPreset: async id => {
      if (resolved.preset === undefined || agentPresets === undefined) return
      await presetChoice.presetFor(SessionId(id), true, undefined)
    },
    openPicker: (picker, vet) => modalInput.openPicker(picker, vet),
  })

  /**
   * Open the key map over the surface.
   *
   * Nothing here is a pick: a row names an action and the keys reaching it, so
   * the id the list settles on is thrown away. What the reader came for is the
   * list itself, and the filter that narrows it.
   */
  const openKeyMap = (layer: ActionLayer | undefined): void => {
    void modalInput.openPicker(new KeymapPicker(appearance.keymap, layer), undefined, 'popup')
  }

  stash = promptMemory.buildStash()

  /** The live session this process runs, which is the only source holding an unflushed tail. */
  const liveSession = (id: SessionId): { snapshotEvents?: () => readonly ForkEvent[] } | undefined =>
    (ctx.get('sessions') as { get?: (id: SessionId) => { snapshotEvents?: () => readonly ForkEvent[] } | undefined } | undefined)?.get?.(id)

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
   * Write what the reader can see to a file.
   *
   * The base's `/export` downloads the log through the browser, which a
   * terminal has no way to do, so this dumps the transcript the reader is
   * looking at — the thing worth pasting into a message.
   */
  const runExportCommand = (argument: string): void => {
    const path = resolve(argument === '' ? defaultExportFile(String(sessionLifecycle.activeSession())) : argument)
    try {
      writeFileSync(path, transcriptToText(sessionView.model.entries()), 'utf8')
      sessionView.notice(`transcript written to ${path}`)
    } catch (error) {
      sessionView.notice(`could not write ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
    tui.requestRender()
  }

  /** Show the todo list the agent has been keeping. */
  const runTodoCommand = (): void => {
    sessionView.notice(describeTodos(sessionView.workState().todos))
    tui.requestRender()
  }

  /**
   * Put the last answer on the reader's clipboard.
   *
   * The clipboard belongs to the terminal, so this asks it through OSC 52 —
   * which is also the only route that works over SSH.
   */
  const runCopyCommand = (): void => {
    const last = [...sessionView.model.entries()].reverse().find(entry => entry.kind === 'assistant')
    if (last === undefined || last.kind !== 'assistant') {
      sessionView.notice('nothing to copy yet')
      tui.requestRender()
      return
    }
    terminal.write(clipboardSequence(last.text))
    sessionView.notice(`copied ${last.text.length} characters through the terminal`)
    tui.requestRender()
  }


  const helpText = (): string => {
    const current = sessionLifecycle.drivingAgent()?.agent
    const registered = current === undefined || registry() === undefined
      ? []
      : registry()?.list(current).map(command => `/${command.name}`) ?? []
    const commands = registered.length === 0 ? 'none registered yet' : registered.join(' ')
    return `commands: ${commands} · surface: ${LOCAL_COMMANDS.join(' ')} · keys: ${surfaceKeysLine(appearance.keymap())} · ${chordKeysLine(appearance.keymap())}`
  }

  /**
   * Whether the agent this surface is driving is in plan mode.
   *
   * The dock's fold is the fallback, for a composition without the plan
   * package: with the controller present its answer is the agent's own state
   * rather than a replay of the events this surface happened to see.
   */
  const planState = (): PlanModeState | undefined => {
    const current = sessionLifecycle.drivingAgent()?.agent
    if (current === undefined) return undefined
    const presets = ctx.get('agentPresets') as ServiceFor | undefined
    return readPlanState({
      direct: name => ctx.get(name),
      forAgent: (target, name) => presets?.serviceFor(target, name),
    }, current)
  }

  const planActive = (): boolean => planSelectedActive(planState(), sessionView.workState().planMode)

  const runCommand = (name: string, line: string): void => {
    const current = sessionLifecycle.drivingAgent()
    const commands = registry()
    if (current === undefined) {
      sessionView.notice('the agent is still starting; try again in a moment')
      tui.requestRender()
      return
    }
    if (commands === undefined || commands.find(current.agent, name) === undefined) {
      sessionView.notice(`unknown command: /${name} — ${helpText()}`)
      tui.requestRender()
      return
    }
    const controller = new AbortController()
    void commands.execute(current.agent, line, [], controller.signal).then(execution => {
      const result = execution?.result
      if (result === undefined) return
      sessionView.notice(result.kind === 'error' ? `/${name} failed: ${result.text ?? 'no detail'}` : `/${name} ${result.text ?? 'done'}`)
      tui.requestRender()
    }).catch((error: unknown) => {
      sessionView.notice(`/${name} failed: ${error instanceof Error ? error.message : String(error)}`)
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
        modelChoice.runModelCommand(submission.argument)
        return
      case 'preset':
        presetChoice.runPresetCommand(submission.argument)
        return
      case 'jobs':
        backgroundWork.runJobsCommand(submission.argument)
        return
      case 'rename':
        sessionLifecycle.runRenameCommand(submission.title)
        return
      case 'export':
        runExportCommand(submission.path)
        return
      case 'subagents':
        backgroundWork.runSubagentsCommand(submission.argument)
        return
      case 'fork':
        sessionLifecycle.runForkCommand(submission.title)
        return
      case 'new':
        sessionLifecycle.runNewCommand(submission.title)
        return
      case 'reload':
        sessionLifecycle.runReloadCommand()
        return
      case 'todo':
        runTodoCommand()
        return
      case 'theme':
        appearance.runThemeCommand(submission.argument)
        return
      case 'keys': {
        const layer = submission.argument === '' ? undefined : keymapLayer(submission.argument)
        // A layer that does not exist is not a filter that matches nothing: the
        // reader asked for something by name, so the answer names the names.
        if (submission.argument !== '' && layer === undefined) {
          sessionView.notice(`unknown layer "${submission.argument}" · ${KEYMAP_LAYERS.join(' ')}`)
          tui.requestRender()
          return
        }
        openKeyMap(layer)
        return
      }
      case 'copy':
        runCopyCommand()
        return
      case 'history':
        promptMemory.runHistoryCommand(submission.argument)
        return
      case 'stash':
        // Submitting a command consumes the line it was typed on, so this path
        // can only carry a draft it was given; parking the bar's own draft is
        // what the chord is for.
        if (submission.argument.trim() === '') sessionView.notice('usage: /stash <draft>, or ctrl+x then s to park the editor')
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
        void stash?.list(String(sessionLifecycle.activeSession()))
        return
      case 'stash-drop':
        void stash?.drop(submission.selector)
        return
      case 'stash-clear':
        void stash?.clear()
        return
      case 'editor':
        editDraft()
        return
      case 'status': {
        const facts = statusFacts()
        const context = facts.contextTokens === undefined
          ? undefined
          : `context ${formatTokens(facts.contextTokens)}${facts.contextWindow === undefined ? '' : `/${formatTokens(facts.contextWindow)}`}`
        sessionView.notice([
          `session ${sessionLifecycle.activeSession()}`,
          sessionView.viewingChild() ? undefined : `viewing ${sessionView.viewed()}`,
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
        sessionView.reset()
        tui.requestRender()
        return
      case 'undo':
        stagedTurns.undo()
        return
      case 'redo':
        stagedTurns.redo()
        return
      case 'help':
        sessionView.notice(helpText())
        tui.requestRender()
        return
      case 'resume':
        void sessionPicker.chooseSession().then(picked => picked === undefined ? undefined : sessionLifecycle.switchSession(picked)).catch((error: unknown) => {
          sessionView.notice(`could not resume: ${error instanceof Error ? error.message : String(error)}`)
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
      case 'prompt': {
        const driven = sessionLifecycle.drivingAgent()
        if (driven === undefined) {
          sessionView.notice('the agent is still starting; try again in a moment')
          tui.requestRender()
          return
        }
        // While a turn is running the human is steering it, not opening another.
        if (sessionLifecycle.turnRunning()) driven.steer(submission.text)
        else {
          modelChoice.adoptDefault()
          void stagedTurns.send(submission.text)
        }
        return
      }
    }
  }

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

  const degraded = describeMissingOptional(probe)
  if (degraded !== undefined) sessionView.notice(degraded)

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
      await sessionLifecycle.openAgent(resolved.sessionId, resolved.resume)
      return
    }
    const picked = await sessionPicker.chooseSession()
    if (picked === undefined) {
      requestExit(0)
      return
    }
    await sessionLifecycle.openAgent(picked, true)
  }

  /**
   * Take the screen, then open the session this run was launched for.
   *
   * A mode named on the command line is resolved FIRST: the alt screen swallows
   * the launcher's own error output, so a mode this roster does not offer has to
   * be answered while the shell still owns the terminal.
   */
  const start = async (): Promise<void> => {
    // A named mode that disagrees with the one this session recorded is refused
    // here as well as at the open, because the alternate screen closes over
    // whatever was painted on it: the reader would see the failure, not the
    // reason.
    await presetChoice.validateLaunch({
      sessionId: resolved.sessionId,
      resume: resolved.resume,
      resumePicker: resolved.resumePicker,
    })
    tui.start()
    writeTerminal(windowTitle(process.cwd(), 'ready'))
    // Claiming the pane's agent row does not wait for a session: the pane is
    // already on screen and already idle, and a session may still be chosen.
    herdr.publish()
    // A refused settings edit is only visible now that the surface owns the
    // screen; whatever the scope found before this point prints here instead.
    appearance.openNotices(message => sessionView.notice(message))
    await boot()
  }

  void start().catch((error: unknown) => {
    requestExit(1, error instanceof Error ? error.message : String(error))
  })
}
