import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { PresetRoster } from '../agent/presets.ts'
import { defaultExportFile, ensureExportsHome, exportsHomeDir, transcriptToText, writeTranscriptExport } from '../export.ts'
import type { ActionLayer } from '../input/action-catalog.ts'
import type { RegisteredCommand } from '../input/completion.ts'
import { chordKeysLine, surfaceKeysLine } from '../input/keymap.ts'
import { LOCAL_COMMANDS, type Submission } from '../input/submission.ts'
import { KEYMAP_LAYERS, keymapLayer } from '../keys-command.ts'
import type { PromptStash } from '../stash.ts'
import { clipboardSequence } from '../terminal/clipboard.ts'
import { createSurfaceStart } from './startup.ts'
import { TUI_PROFILING_SERVICE, PROFILE_CATEGORY, profileAsync, PROFILE_PHASE, PROFILE_MILESTONE } from '../profiling.ts'
import { formatTokens } from '../tokens.ts'
import { KeymapPicker } from '../ui/keymap-picker.ts'
import type { StatusFacts } from '../ui/status.ts'
import { describeTodos, planSelectedActive, planToggleLine, readPlanState, type PlanModeState } from '../work.ts'
import type { Appearance } from './appearance.ts'
import type { BackgroundWork } from './background-work.ts'
import type { ModalInput } from './modal-input.ts'
import type { ModelChoice } from './model-choice.ts'
import type { PresetChoice, PresetLaunch } from './preset-choice.ts'
import type { PromptMemory } from './prompt-memory.ts'
import type { SessionLifecycle } from './session-lifecycle.ts'
import { createSessionPicker } from './session-picker.ts'
import type { SessionView } from './session-view.ts'
import type { StagedTurns } from './staged-turns.ts'
import type { TerminalLifecycle } from './terminal-lifecycle.ts'

/**
 * The command plane: where a typed line, a chord, a host command, and the
 * launcher's own request meet.
 *
 * Both interactive routes into the surface arrive as the same classified
 * submission — a chord cannot behave differently from the command it stands for
 * — so carrying one out is a single router rather than a handler per feature.
 * The launch sits here for the same reason: a bare `--resume` asks the question
 * a resume typed later asks, and the session picker answers both. Nothing but
 * the decisions is kept here: every case delegates to the owner that holds what
 * it is about, and only the host's command registry and the plan service are
 * read from the composition itself, because a command the surface did not write
 * is reachable nowhere else.
 */

/** Plan state belongs to the driven agent's composition; only its scoped service lookup is needed here. */
interface ServiceFor {
  serviceFor(agent: unknown, name: string): unknown
}

/**
 * The command registry, described structurally: the surface only lists,
 * looks up, and dispatches human commands, so it does not depend on the
 * command package's full surface.
 */
interface CommandRegistry {
  list(agent: Agent): readonly RegisteredCommand[]
  find(agent: Agent, name: string): unknown
  execute(agent: Agent, line: string, attachments: readonly unknown[], signal: AbortSignal): Promise<
    { readonly result: { readonly kind: 'success' | 'error'; readonly text?: string } } | undefined
  >
}

/**
 * What the command plane needs from the surface that composes it.
 *
 * Each owner arrives whole, because this module is the one place that knows
 * which of their operations a typed line, a chord, or the launch maps onto; the
 * reads it takes of them are live, so a command typed after a session switch
 * answers for the session now on screen. The launch facts and the mode roster
 * are the two things no owner holds, and the notice and render sinks are what a
 * refusal and a repaint are printed through.
 */
export interface CommandsPorts {
  /** Optional addon actions use the same human-input router as built-in commands. */
  readonly runPluginAction?: (id: string) => Promise<void>
  /** The launch this run was started for, and the mode its own flag named. */
  readonly launch: PresetLaunch
  readonly preset: string | undefined
  /** The roster that can say whether a stored session's mode still exists. */
  readonly presetRoster: PresetRoster | undefined
  /** A composition row that is missing, printed before the screen is taken. */
  readonly missingOptional: () => string | undefined
  /** An installed skill this build moved past, printed once at startup. */
  readonly skillDrift: () => string | undefined
  readonly session: SessionLifecycle
  readonly transcript: SessionView
  readonly route: ModelChoice
  readonly modes: PresetChoice
  readonly work: BackgroundWork
  readonly staged: StagedTurns
  readonly memory: PromptMemory
  readonly appearance: Appearance
  /** The terminal this surface owns, which is where a copy is written. */
  readonly terminal: TerminalLifecycle
  /** The one modal interaction at a time, which lends its keyboard to a list. */
  readonly modals: ModalInput
  readonly statusFacts: () => StatusFacts
  /** The bank the parked-draft commands read, late-bound behind the picker it needs. */
  readonly stash: () => PromptStash | undefined
  readonly render: () => void
}

/** The operations the composing surface routes back into the command plane. */
export interface Commands {
  /** Carry out one classified line, wherever it was asked for. */
  readonly runSubmission: (submission: Submission) => void
  /**
   * The commands one agent can run, or undefined when no registry answers.
   *
   * A scoped read rather than the registry itself: the registry stays with this
   * owner, and completion only ever needs the names it offers.
   */
  readonly registeredCommands: (agent: Agent) => readonly RegisteredCommand[] | undefined
  /**
   * Take the screen, then open the session this run was launched for.
   *
   * The launch belongs to this owner because the resume it may ask is the same
   * question the resume command asks, answered by the same list.
   */
  readonly start: () => Promise<void>
}

/**
 * The router over everything the reader and the launcher can ask for.
 *
 * The registry is read from the composition rather than taken as a port: it is
 * scoped to the agent in service, so its listing, lookup and dispatch all have
 * to follow whichever agent the surface is driving now.
 */
export function createCommands(ctx: Context, ports: CommandsPorts): Commands {
  const registry = (): CommandRegistry | undefined => ctx.get('commands') as CommandRegistry | undefined
  // The copy is the one write that must land even while a child owns the tty:
  // the reader asked for the last answer, not for a title, and a handoff that
  // swallowed it would leave the clipboard silently empty.
  const writeTty = (text: string): void => ports.terminal.terminal.write(text)

  /**
   * Open the key map over the surface.
   *
   * Nothing here is a pick: a row names an action and the keys reaching it, so
   * the id the list settles on is thrown away. What the reader came for is the
   * list itself, and the filter that narrows it.
   */
  const openKeyMap = (layer: ActionLayer | undefined): void => {
    void ports.modals.openPicker(new KeymapPicker(ports.appearance.keymap, layer), undefined, 'popup')
  }

  /**
   * Write what the reader can see to a file.
   *
   * The base's `/export` downloads the log through the browser, which a
   * terminal has no way to do, so this dumps the transcript the reader is
   * looking at — the thing worth pasting into a message.
   */
  const runExportCommand = (argument: string): void => {
    let path: string
    if (argument === '') {
      // No destination named: the dump gets a directory of its own under the
      // harness home, because resolving a bare file name against the working
      // directory drops a session file into whatever checkout the reader
      // happened to start from, and the shared theme directory belongs to
      // `/theme export` and is watched for theme edits.
      const home = exportsHomeDir()
      const problems = ensureExportsHome(home)
      if (problems.length > 0) {
        for (const problem of problems) ports.transcript.notice(problem)
        ports.render()
        return
      }
      path = join(home, defaultExportFile(String(ports.session.activeSession())))
    } else {
      path = resolve(argument)
    }
    try {
      const text = transcriptToText(ports.transcript.model.entries())
      writeTranscriptExport(path, text)
      ports.transcript.notice(`transcript written to ${path}`)
    } catch (error) {
      ports.transcript.notice(`could not write ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
    ports.render()
  }

  /** Inspect the visible todo projection locally, without asking the agent to start another turn. */
  const runTodoCommand = (): void => {
    const work = ports.transcript.workState()
    ports.transcript.notice(describeTodos(work.todos, work.todoState))
    ports.render()
  }

  /**
   * OSC 52 asks the reader's terminal to update its clipboard, avoiding a
   * clipboard API on the remote host when the surface runs over SSH.
   */
  const runCopyCommand = (): void => {
    const last = [...ports.transcript.model.entries()].reverse().find(entry => entry.kind === 'assistant')
    if (last === undefined || last.kind !== 'assistant') {
      ports.transcript.notice('nothing to copy yet')
      ports.render()
      return
    }
    writeTty(clipboardSequence(last.text))
    ports.transcript.notice(`copied ${last.text.length} characters through the terminal`)
    ports.render()
  }

  // Include agent commands, surface commands, and active bindings so help and
  // unknown-command refusals expose both typed and keyboard input routes.
  const helpText = (): string => {
    const current = ports.session.drivingAgent()?.agent
    // Read once: the registry is the surface's own lookup, and asking it twice
    // for one line would let a changing roster answer the two halves differently.
    const roster = registry()
    const registered = current === undefined || roster === undefined ? [] : roster.list(current).map(command => `/${command.name}`)
    const commands = registered.length === 0 ? 'none registered yet' : registered.join(' ')
    return `commands: ${commands} · surface: ${LOCAL_COMMANDS.join(' ')} · keys: ${surfaceKeysLine(ports.appearance.keymap())} · ${chordKeysLine(ports.appearance.keymap())}`
  }

  /**
   * Whether the agent this surface is driving is in plan mode.
   *
   * The dock's fold is the fallback, for a composition without the plan
   * package: with the controller present its answer is the agent's own state
   * rather than a replay of the events this surface happened to see.
   */
  const planState = (): PlanModeState | undefined => {
    const current = ports.session.drivingAgent()?.agent
    if (current === undefined) return undefined
    const presets = ctx.get('agentPresets') as ServiceFor | undefined
    return readPlanState({
      direct: name => ctx.get(name),
      forAgent: (target, name) => presets?.serviceFor(target, name),
    }, current)
  }

  const planActive = (): boolean => planSelectedActive(planState(), ports.transcript.workState().planMode)

  const runCommand = (name: string, line: string): void => {
    const current = ports.session.drivingAgent()
    const commands = registry()
    if (current === undefined) {
      ports.transcript.notice('the agent is still starting; try again in a moment')
      ports.render()
      return
    }
    if (commands === undefined || commands.find(current.agent, name) === undefined) {
      ports.transcript.notice(`unknown command: /${name} — ${helpText()}`)
      ports.render()
      return
    }
    // The registry requires a signal; Ctrl+C targets the driven turn, not this command.
    // Dispatch stays off the synchronous input route so further submissions remain available.
    const controller = new AbortController()
    void commands.execute(current.agent, line, [], controller.signal).then(execution => {
      const result = execution?.result
      if (result === undefined) return
      ports.transcript.notice(result.kind === 'error' ? `/${name} failed: ${result.text ?? 'no detail'}` : `/${name} ${result.text ?? 'done'}`)
      ports.render()
    }).catch((error: unknown) => {
      ports.transcript.notice(`/${name} failed: ${error instanceof Error ? error.message : String(error)}`)
      ports.render()
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
        ports.terminal.requestExit(0)
        return
      case 'plugin-action':
        void ports.runPluginAction?.(submission.id)
        return
      case 'model':
        ports.route.runModelCommand(submission.argument)
        return
      case 'preset':
        ports.modes.runPresetCommand(submission.argument)
        return
      case 'jobs':
        ports.work.runJobsCommand(submission.argument)
        return
      case 'rename':
        ports.session.runRenameCommand(submission.title)
        return
      case 'export':
        runExportCommand(submission.path)
        return
      case 'subagents':
        ports.work.runSubagentsCommand(submission.argument)
        return
      case 'fork':
        ports.session.runForkCommand(submission.title)
        return
      case 'new':
        ports.session.runNewCommand(submission.title)
        return
      case 'reload':
        ports.session.runReloadCommand()
        return
      case 'todo':
        runTodoCommand()
        return
      case 'theme':
        ports.appearance.runThemeCommand(submission.argument)
        return
      case 'keys': {
        const layer = submission.argument === '' ? undefined : keymapLayer(submission.argument)
        // A layer that does not exist is not a filter that matches nothing: the
        // reader asked for something by name, so the answer names the names.
        if (submission.argument !== '' && layer === undefined) {
          ports.transcript.notice(`unknown layer "${submission.argument}" · ${KEYMAP_LAYERS.join(' ')}`)
          ports.render()
          return
        }
        openKeyMap(layer)
        return
      }
      case 'copy':
        runCopyCommand()
        return
      case 'history':
        ports.memory.runHistoryCommand(submission.argument)
        return
      case 'stash':
        // Submitting a command consumes the line it was typed on, so this path
        // can only carry a draft it was given; parking the bar's own draft is
        // what the chord is for.
        if (submission.argument.trim() === '') ports.transcript.notice('usage: /stash <draft>, or ctrl+x then s to park the editor')
        else void ports.stash()?.stashEditor(submission.argument)
        return
      case 'stash-draft':
        void ports.stash()?.stashEditor()
        return
      case 'stash-pop':
        void ports.stash()?.pop(submission.selector)
        return
      case 'stash-apply':
        void ports.stash()?.apply(submission.selector)
        return
      case 'stash-list':
        void ports.stash()?.list(String(ports.session.activeSession()))
        return
      case 'stash-drop':
        void ports.stash()?.drop(submission.selector)
        return
      case 'stash-clear':
        void ports.stash()?.clear()
        return
      case 'editor':
        ports.terminal.editDraft()
        return
      case 'status': {
        const facts = ports.statusFacts()
        const context = facts.contextTokens === undefined
          ? undefined
          : `context ${formatTokens(facts.contextTokens)}${facts.contextWindow === undefined ? '' : `/${formatTokens(facts.contextWindow)}`}`
        ports.transcript.notice([
          `session ${ports.session.activeSession()}`,
          // Status describes the driven session; a child transcript ID would label another agent
          // alongside this session's model, permissions, and context.
          ports.transcript.viewingChild() ? undefined : `viewing ${ports.transcript.viewed()}`,
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
        ports.render()
        return
      }
      case 'clear':
        // Keep /clear display-only so clearing the screen does not discard resumable session history.
        ports.transcript.reset()
        ports.render()
        return
      case 'undo':
        ports.staged.undo()
        return
      case 'redo':
        ports.staged.redo()
        return
      case 'help':
        ports.transcript.notice(helpText())
        ports.render()
        return
      case 'resume':
        void sessionPicker.chooseSession().then(picked => picked === undefined ? undefined : ports.session.switchSession(picked)).catch((error: unknown) => {
          ports.transcript.notice(`could not resume: ${error instanceof Error ? error.message : String(error)}`)
          ports.render()
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
        const driven = ports.session.drivingAgent()
        if (driven === undefined) {
          ports.transcript.notice('the agent is still starting; try again in a moment')
          ports.render()
          return
        }
        // While a turn is running the human is steering it, not opening another.
        if (ports.session.turnRunning()) driven.steer(submission.text)
        else {
          // Before sending, let an unset route adopt the late-loaded default
          // so the composition placeholder does not override the available settings.
          ports.route.adoptDefault()
          void ports.staged.send(submission.text)
        }
        return
      }
    }
  }

  /**
   * Where a bare `--resume` gets its list, and the ports it drives.
   *
   * The keyboard is taken through a port rather than here: how a picker holds
   * it, and how long it may, is the modal owner's business.
   */
  const sessionPicker = createSessionPicker(ctx, {
    keymap: ports.appearance.keymap,
    notice: ports.transcript.notice,
    render: ports.render,
    // A stored session's own mode can only disagree with one this run named, and
    // only a roster can say whether the name it uses still exists.
    validateStoredPreset: async id => {
      if (ports.preset === undefined || ports.presetRoster === undefined) return
      await ports.modes.presetFor(SessionId(id), true, undefined)
    },
    openPicker: (picker, vet) => {
      const profiling = ctx.get(TUI_PROFILING_SERVICE)
      const result = ports.modals.openPicker(picker, vet)
      if (profiling !== undefined && ports.launch.resumePicker && !profiling.has(PROFILE_MILESTONE.inputReady)) {
        profiling?.mark(PROFILE_MILESTONE.pickerReady)
        profiling.mark(PROFILE_MILESTONE.inputReady)
        return profileAsync(profiling, PROFILE_PHASE.picker, () => result, PROFILE_CATEGORY.userWait)
      }
      return result
    },
  })

  /**
   * Open the session this run was launched for.
   *
   * A bare `--resume` asks a question only the reader can answer, so the
   * picker runs before anything is created: the agent is then opened on the
   * chosen session rather than swapped afterwards, which would leave the first
   * one's turn half-started.
   */
  const boot = async (): Promise<void> => {
    if (!ports.launch.resumePicker) {
      await profileAsync(ctx.get(TUI_PROFILING_SERVICE), PROFILE_PHASE.boot, () => ports.session.openAgent(ports.launch.sessionId, ports.launch.resume))
      return
    }
    const picked = await sessionPicker.chooseSession()
    if (picked === undefined) {
      ports.terminal.requestExit(0)
      return
    }
    await profileAsync(ctx.get(TUI_PROFILING_SERVICE), PROFILE_PHASE.boot, () => ports.session.openAgent(picked, true))
  }

  const start = createSurfaceStart(ctx, ports, boot)

  return {
    runSubmission,
    registeredCommands: agent => registry()?.list(agent),
    start,
  }
}
