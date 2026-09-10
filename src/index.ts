import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Editor, ProcessTerminal, ScrollView, TuiAltScreen, VStack, matchesKey } from '@earendil-works/pi-tui'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Type-only: the command registry publishes the change event this surface
// listens to, and the event map is declaration-merged by that package.
import type {} from '@deepseek-ai/dsh-commands'
import { startAgent, type TuiAgent } from './agent/host.ts'
import {
  PICKER_LIMIT,
  createSessionHistory,
  readSessionTitle,
  type SessionHistory,
  type StoredSession,
} from './agent/history.ts'
import { createToolPresenter } from './agent/present.ts'
import { createStatusFacts } from './agent/status.ts'
import { ModelSwitch, createModelCatalog, parseModelArgument } from './agent/model.ts'
import { JOB_READ_LINES, createJobDirectory, describeJobs, parseJobsArgument, type JobSummary } from './jobs.ts'
import {
  SubagentRoster,
  createSubagentControl,
  describeSubagents,
  parseSubagentsArgument,
} from './subagents.ts'
import { describeMissingOptional, describeMissingRequired, probeComposition } from './compat/probe.ts'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import { ApprovalGate, QuestionGate, toGateQuestions, type GateAnswer } from './gates.ts'
import { createCompletionProvider } from './input/completion.ts'
import { LOCAL_COMMANDS, classifySubmission } from './input/submission.ts'
import { resolveConfig } from './config.ts'
import { createRestoreRegistry } from './terminal/restore.ts'
import { CLEAR_TITLE, windowTitle } from './terminal/title.ts'
import { defaultExportFile, transcriptToText } from './export.ts'
import { createTheme } from './theme.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TranscriptModel } from './transcript.ts'
import { WorkFold } from './work.ts'
import { WorkDock } from './ui/dock.ts'
import { MarkdownRenderer } from './ui/markdown.ts'
import { SessionPicker } from './ui/picker.ts'
import { StatusBar, formatTokens } from './ui/status.ts'
import { TranscriptView } from './ui/view.ts'

export const name = 'tui'

/** `agents` is the only service the surface cannot run without. */
export const inject = ['agents']

const GOODBYE_KEY = 'tuiGoodbyeMessage'

/** Keys the surface answers itself, listed wherever the reader asks for help. */
const LOCAL_KEYS = 'ctrl+o tool detail · ctrl+t reasoning · ctrl+c interrupt or exit'

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

  const theme = createTheme(resolved.color)
  const model = new TranscriptModel(createToolPresenter(ctx))
  const work = new WorkFold()
  const modelSwitch = new ModelSwitch()
  const catalog = createModelCatalog(ctx)
  const jobDirectory = createJobDirectory(ctx)
  let jobs: readonly JobSummary[] = []
  const roster = new SubagentRoster()
  const subagentControl = createSubagentControl(ctx)
  const markdown = new MarkdownRenderer(theme.markdown)
  /** Rows the reader has opened. The model stays untouched; only the view reads this. */
  const viewState = { expandCards: false, expandReasoning: false }
  const restore = createRestoreRegistry()
  const terminal = new ProcessTerminal()
  const tui = new TuiAltScreen(terminal)
  /** The one gate a terminal can present at a time, and how it settles its caller. */
  type PendingGate =
    | { readonly kind: 'approval'; readonly gate: ApprovalGate; readonly settle: (outcome: ApprovalOutcome) => void }
    | { readonly kind: 'question'; readonly gate: QuestionGate; readonly settle: (answers: GateAnswer[]) => void }

  /** The session the surface is showing, which a resume can change. */
  let activeSession = resolved.sessionId
  /** The one picker a terminal can present at a time, and how it settles its caller. */
  interface PendingPicker {
    readonly picker: SessionPicker
    readonly settle: (id: SessionId | undefined) => void
  }
  let pending: PendingGate | undefined
  let pendingPicker: PendingPicker | undefined
  const view = new TranscriptView(model, theme, markdown, {
    state: () => viewState,
    gate: () => pending?.gate.card(),
    picker: () => pendingPicker?.picker.card(),
  })
  const editor = new Editor(tui, theme.editor)
  const disposers: Array<() => void> = []
  let agent: TuiAgent | undefined
  let turnOpen = false
  let turnStartedAt: number | undefined
  let exited = false
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

  const requestExit = (code: number): void => {
    if (exited) return
    exited = true
    clearInterval(statusTicker)
    // Hand the window label back before the screen does, so a shell that sets
    // its own title can take over cleanly.
    terminal.write(CLEAR_TITLE)
    restore.restore()
    const goodbye = ctx.get(GOODBYE_KEY)
    if (typeof goodbye === 'string' && goodbye !== '') terminal.write(`\n${goodbye}\n`)
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
      if (action === undefined) tui.requestRender()
      else {
        const settle = pendingPicker.settle
        pendingPicker = undefined
        editor.disableSubmit = false
        tui.setFocus(editor)
        settle(action.kind === 'pick' ? SessionId(action.id) : undefined)
        tui.requestRender()
      }
      return { consume: true }
    }
    // Detail the reader asked for is always available, even mid-turn: the
    // collapsed view is a default, not the only state.
    if (matchesKey(data, 'ctrl+o')) {
      viewState.expandCards = !viewState.expandCards
      tui.requestRender()
      return { consume: true }
    }
    if (matchesKey(data, 'ctrl+t')) {
      viewState.expandReasoning = !viewState.expandReasoning
      tui.requestRender()
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
  const askForSession = (history: SessionHistory, sessions: readonly StoredSession[]): Promise<SessionId | undefined> => {
    const titles = new Map<string, string>()
    void loadTitles(history, sessions, titles)
    const picker = new SessionPicker(sessions, () => titles)
    return new Promise<SessionId | undefined>(resolve => {
      pendingPicker = { picker, settle: resolve }
      editor.disableSubmit = true
      tui.setFocus(null)
      tui.requestRender()
    })
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
  const replayHistory = async (id: SessionId): Promise<void> => {
    const history = createSessionHistory(ctx)
    if (history === undefined) return
    try {
      const events = await history.read(id)
      if (events.length === 0) return
      for (const event of events) applyEvent(event)
      model.notice(`replayed ${events.length} events from the stored log`)
    } catch (error) {
      model.notice(`could not replay this session: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Feed one durable event to everything that folds it. */
  const applyEvent = (event: { readonly type: string; readonly data?: unknown }): void => {
    model.apply(event)
    work.apply(event)
  }

  const openAgent = async (id: SessionId, resume: boolean): Promise<void> => {
    if (resume) await replayHistory(id)
    const handle = await startAgent(ctx, {
      sessionId: id,
      resume,
      model: resolved.model,
      provider: resolved.provider,
      cwd: process.cwd(),
      setup: agentCtx => modelSwitch.install(agentCtx),
    })
    activeSession = id
    agent = handle
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
        model.notice(`model ${route} · providers: ${providers.length === 0 ? 'none' : providers.join(', ')} · /model <provider>/<model> switches, /model <provider> lists its models`)
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
      case 'switch':
        modelSwitch.choose(command.choice)
        model.notice(`model set to ${command.choice.provider}/${command.choice.model} for the next step`)
        tui.requestRender()
        return
      case 'invalid':
        model.notice(`/model: ${command.reason}`)
        tui.requestRender()
        return
    }
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
      case 'status': {
        const facts = statusFacts()
        const context = facts.contextTokens === undefined
          ? undefined
          : `context ${formatTokens(facts.contextTokens)}${facts.contextWindow === undefined ? '' : `/${formatTokens(facts.contextWindow)}`}`
        model.notice([
          `session ${activeSession}`,
          facts.model === undefined ? undefined : `model ${facts.model}${facts.effort === undefined ? '' : ` (${facts.effort})`}`,
          facts.preset === undefined ? undefined : `permissions ${facts.preset}`,
          context,
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
        else agent.submit(submission.text)
    }
  }

  disposers.push(ctx.on('session/event', (session, event) => {
    if (session.id !== activeSession) return
    if (event.type === 'turn/start') {
      turnOpen = true
      turnStartedAt = Date.now()
      terminal.write(windowTitle(process.cwd(), 'working'))
    }
    if (event.type === 'turn/end') {
      turnOpen = false
      turnStartedAt = undefined
      terminal.write(windowTitle(process.cwd(), 'ready'))
      // A job the turn started may have settled while the reader was watching
      // something else, and nothing else refreshes a live board.
      refreshJobs()
      return
    }
    applyEvent(event)
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

  tui.start()
  terminal.write(windowTitle(process.cwd(), 'ready'))

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

  void boot().catch((error: unknown) => {
    terminal.write(`\ndsh-tui: ${error instanceof Error ? error.message : String(error)}\n`)
    requestExit(1)
  })
}
