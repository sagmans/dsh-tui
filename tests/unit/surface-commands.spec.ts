import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defaultExportFile, transcriptToText } from '@/export.ts'
import { defaultKeymap } from '@/input/actions.ts'
import type { RegisteredCommand } from '@/input/completion.ts'
import { chordKeysLine, surfaceKeysLine } from '@/input/keymap.ts'
import { LOCAL_COMMANDS, type Submission } from '@/input/submission.ts'
import { KEYMAP_LAYERS } from '@/keys-command.ts'
import { createCommands } from '@/surface/commands.ts'
import type { Picker } from '@/surface/modal-input.ts'
import type { PromptStash } from '@/stash.ts'
import { clipboardSequence } from '@/terminal/clipboard.ts'
import { windowTitle } from '@/terminal/title.ts'
import { THEMES_DIR_NAME } from '@/theme-files.ts'
import { formatTokens } from '@/tokens.ts'
import type { TranscriptEntry } from '@/transcript.ts'
import type { StatusFacts } from '@/ui/status.ts'
import { describeTodos, type TodoEntry } from '@/work.ts'

const SESSION = 'tui-session-1' as SessionId
const VIEWED = 'stored-2' as SessionId
const STORED = 'stored-1'
const AGENT = { id: 'agent-1' } as unknown as Agent
const DRAFT = 'a draft worth keeping'
const ANSWER = 'the last one'

/** The commands the host registry answers with, as completion reads them. */
function command(name: string): RegisteredCommand {
  return { name } as unknown as RegisteredCommand
}

/**
 * The one line /help and an unknown command both answer with.
 *
 * The key listings are long and owned by the keymap readers, so they are read
 * from those exports rather than copied: a remap must not fail this spec.
 */
function helpFor(names: readonly string[]): string {
  const map = defaultKeymap()
  const commands = names.length === 0 ? 'none registered yet' : names.join(' ')
  return 'commands: ' + commands + ' · surface: ' + LOCAL_COMMANDS.join(' ') + ' · keys: ' + surfaceKeysLine(map) + ' · ' + chordKeysLine(map)
}

function facts(overrides: Partial<StatusFacts> = {}): StatusFacts {
  return {
    chord: undefined,
    back: undefined,
    activity: 'idle',
    elapsedMs: undefined,
    provider: undefined,
    model: undefined,
    effort: undefined,
    agentPreset: undefined,
    preset: undefined,
    contextTokens: undefined,
    contextWindow: undefined,
    cacheRate: undefined,
    uncachedInputTokens: undefined,
    outputTokens: undefined,
    cwd: '/w',
    home: undefined,
    ...overrides,
  }
}

/** The driving agent is read live and steered, so the fake has to follow both. */
interface Driver {
  readonly agent: Agent
  readonly steer: (text: string) => void
}

type Ports = Parameters<typeof createCommands>[1]

interface Call {
  readonly name: string
  readonly args: readonly unknown[]
}

/** What the host registry was asked, and what it answers next. */
interface Registry {
  listed: readonly RegisteredCommand[]
  readonly agents: Agent[]
  readonly lookups: string[]
  readonly executions: { line: string; attachments: readonly unknown[]; signal: AbortSignal }[]
  reply: 'success' | 'error' | 'none'
  text: string | undefined
  failure: unknown
}

interface Fixture {
  /** Assigned once the ports can read the fixture back. */
  ctx: Context
  ports: Ports
  readonly services: Map<string, unknown>
  /** Every port call but the notice and render sinks. */
  readonly calls: Call[]
  /** Notice, render and call names in the order the module produced them. */
  readonly order: string[]
  readonly notices: string[]
  renders: number
  driver: Driver | undefined
  turnRunning: boolean
  planMode: boolean
  todos: readonly TodoEntry[] | undefined
  entries: TranscriptEntry[]
  viewingChild: boolean
  facts: StatusFacts
  preset: string | undefined
  presetRoster: unknown
  presetForError: unknown
  launch: { readonly sessionId: SessionId; readonly resume: boolean; readonly resumePicker: boolean }
  missing: string | undefined
  drift: string | undefined
  validateError: unknown
  stash: PromptStash | undefined
  stored: readonly unknown[]
  listError: unknown
  pickerReply: string | undefined
  pickerError: unknown
  vetoOn: string | undefined
  vetoReason: string | undefined
  picker: Picker | undefined
  placement: string | undefined
  sink: ((message: string) => void) | undefined
}

function fixture(): Fixture {
  const calls: Call[] = []
  const order: string[] = []
  const notices: string[] = []
  const services = new Map<string, unknown>()
  const keymap = defaultKeymap()
  const record = (name: string, ...args: unknown[]): void => {
    calls.push({ name, args })
    order.push(name)
  }
  const given = {
    calls,
    order,
    notices,
    services,
    renders: 0,
    driver: { agent: AGENT, steer: (text: string) => record('driver.steer', text) } as Driver | undefined,
    turnRunning: false,
    planMode: false,
    todos: undefined as readonly TodoEntry[] | undefined,
    entries: [] as TranscriptEntry[],
    viewingChild: false,
    facts: facts(),
    preset: undefined as string | undefined,
    presetRoster: undefined as unknown,
    presetForError: undefined as unknown,
    launch: { sessionId: SESSION, resume: false, resumePicker: false },
    missing: undefined as string | undefined,
    drift: undefined as string | undefined,
    validateError: undefined as unknown,
    stash: undefined as PromptStash | undefined,
    stored: [] as readonly unknown[],
    listError: undefined as unknown,
    pickerReply: undefined as string | undefined,
    pickerError: undefined as unknown,
    vetoOn: undefined as string | undefined,
    vetoReason: undefined as string | undefined,
    picker: undefined as Picker | undefined,
    placement: undefined as string | undefined,
    sink: undefined as ((message: string) => void) | undefined,
    ctx: undefined as unknown as Context,
    ports: undefined as unknown as Ports,
  } as Fixture
  given.ctx = { get: (name: string) => services.get(name) } as unknown as Context
  const notice = (message: string): void => {
    notices.push(message)
    order.push('notice')
  }
  const render = (): void => {
    given.renders += 1
    order.push('render')
  }
  given.ports = {
    get launch() {
      return given.launch
    },
    get preset() {
      return given.preset
    },
    get presetRoster() {
      return given.presetRoster as never
    },
    missingOptional: () => given.missing,
    skillDrift: () => given.drift,
    session: {
      activeSession: () => SESSION,
      drivingAgent: () => given.driver as never,
      turnRunning: () => given.turnRunning,
      openAgent: async (id: SessionId, resume: boolean) => {
        record('session.openAgent', id, resume)
        return {} as never
      },
      switchSession: async (id: SessionId) => record('session.switchSession', id),
      runNewCommand: (title: string) => record('session.runNewCommand', title),
      runReloadCommand: () => record('session.runReloadCommand'),
      runForkCommand: (title: string) => record('session.runForkCommand', title),
      runRenameCommand: (title: string) => record('session.runRenameCommand', title),
    } as unknown as Ports['session'],
    transcript: {
      notice,
      reset: () => {
        record('transcript.reset')
        return () => false
      },
      viewingChild: () => given.viewingChild,
      viewed: () => VIEWED,
      model: { entries: () => given.entries },
      workState: () => ({ planMode: given.planMode, todos: given.todos, goal: undefined }),
    } as unknown as Ports['transcript'],
    route: {
      runModelCommand: (argument: string) => record('route.runModelCommand', argument),
      adoptDefault: () => record('route.adoptDefault'),
    } as unknown as Ports['route'],
    modes: {
      runPresetCommand: (argument: string) => record('modes.runPresetCommand', argument),
      presetFor: async (id: SessionId, resume: boolean, fork: unknown) => {
        record('modes.presetFor', id, resume, fork)
        if (given.presetForError !== undefined) throw given.presetForError
        return undefined
      },
      validateLaunch: async (launch: unknown) => {
        record('modes.validateLaunch', launch)
        if (given.validateError !== undefined) throw given.validateError
      },
    } as unknown as Ports['modes'],
    work: {
      runJobsCommand: (argument: string) => record('work.runJobsCommand', argument),
      runSubagentsCommand: (argument: string) => record('work.runSubagentsCommand', argument),
    } as unknown as Ports['work'],
    staged: {
      undo: () => record('staged.undo'),
      redo: () => record('staged.redo'),
      send: (text: string) => {
        record('staged.send', text)
        return Promise.resolve()
      },
    } as unknown as Ports['staged'],
    memory: {
      runHistoryCommand: (argument: string) => record('memory.runHistoryCommand', argument),
    } as unknown as Ports['memory'],
    appearance: {
      keymap: () => keymap,
      runThemeCommand: (argument: string) => record('appearance.runThemeCommand', argument),
      openNotices: (sink: (message: string) => void) => {
        given.sink = sink
        record('appearance.openNotices')
      },
    } as unknown as Ports['appearance'],
    terminal: {
      terminal: { write: (text: string) => record('terminal.terminal.write', text) },
      tui: { start: () => record('terminal.tui.start') },
      writeTerminal: (text: string) => record('terminal.writeTerminal', text),
      requestExit: (code: number) => record('terminal.requestExit', code),
      editDraft: () => record('terminal.editDraft'),
      herdr: { publish: () => record('terminal.herdr.publish') },
    } as unknown as Ports['terminal'],
    modals: {
      openPicker: async (
        picker: Picker,
        vet?: (id: string) => Promise<string | undefined>,
        placement?: 'inline' | 'popup',
      ) => {
        given.picker = picker
        given.placement = placement
        record('modals.openPicker')
        if (given.vetoOn !== undefined && vet !== undefined) given.vetoReason = await vet(given.vetoOn)
        if (given.pickerError !== undefined) throw given.pickerError
        return given.pickerReply
      },
    } as unknown as Ports['modals'],
    statusFacts: () => given.facts,
    stash: () => given.stash,
    render,
  } as unknown as Ports
  return given
}

/** A host registry that answers for one agent, and remembers what it was asked. */
function installRegistry(given: Fixture, overrides: Partial<Registry> = {}): Registry {
  const state: Registry = {
    listed: [],
    agents: [],
    lookups: [],
    executions: [],
    reply: 'success',
    text: undefined,
    failure: undefined,
    ...overrides,
  }
  // The registry is the authority on which commands exist: a name it does not
  // list must reach the unknown-command refusal rather than a dispatch.
  const known = (name: string): boolean => state.listed.some(command => command.name === name)
  given.services.set('commands', {
    list: (agent: Agent) => {
      state.agents.push(agent)
      return state.listed
    },
    find: (_agent: Agent, name: string) => {
      state.lookups.push(name)
      return known(name) ? { name } : undefined
    },
    execute: (agent: Agent, line: string, attachments: readonly unknown[], signal: AbortSignal) => {
      void agent
      state.executions.push({ line, attachments, signal })
      if (state.failure !== undefined) return Promise.reject(state.failure)
      if (state.reply === 'none') return Promise.resolve(undefined)
      return Promise.resolve({ result: { kind: state.reply, text: state.text } })
    },
  })
  return state
}

/** The parked-draft bank, recording what each routing case asked of it. */
function installStash(given: Fixture): void {
  given.stash = {
    stashEditor: async (...args: unknown[]) => given.calls.push({ name: 'stashEditor', args }),
    pop: async (selector: string | undefined) => given.calls.push({ name: 'pop', args: [selector] }),
    apply: async (selector: string | undefined) => given.calls.push({ name: 'apply', args: [selector] }),
    list: async (label: string) => given.calls.push({ name: 'list', args: [label] }),
    drop: async (selector: string | undefined) => given.calls.push({ name: 'drop', args: [selector] }),
    clear: async () => given.calls.push({ name: 'clear', args: [] }),
  } as unknown as PromptStash
}

/** Durable storage the resume picker lists through. */
function installPersistence(given: Fixture): void {
  given.services.set('sessionPersistence', {
    list: async () => {
      if (given.listError !== undefined) throw given.listError
      return given.stored
    },
    open: async () => ({ read: async () => ({ events: [] }), close: async () => {} }),
  })
}

/** Let the router's own promise chain settle; every port here answers at once. */
const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

const dirs: string[] = []
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-commands-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('createCommands registry reads', () => {
  it('lists the host commands for one agent, and nothing when no registry answers', () => {
    const given = fixture()
    const registry = installRegistry(given, { listed: [command('plan')] })
    const commands = createCommands(given.ctx, given.ports)

    expect(commands.registeredCommands(AGENT)).toEqual([command('plan')])
    expect(registry.agents).toEqual([AGENT])

    given.services.delete('commands')
    expect(commands.registeredCommands(AGENT)).toBeUndefined()
  })
})

describe('createCommands routing', () => {
  it('asks nothing for an empty line', () => {
    const given = fixture()
    createCommands(given.ctx, given.ports).runSubmission({ kind: 'empty' })

    expect(given.calls).toEqual([])
    expect(given.notices).toEqual([])
    expect(given.renders).toBe(0)
  })

  it('ends the run with a clean code when the reader quits', () => {
    const given = fixture()
    createCommands(given.ctx, given.ports).runSubmission({ kind: 'quit' })

    expect(given.calls).toEqual([{ name: 'terminal.requestExit', args: [0] }])
  })

  it.each([
    [{ kind: 'model', argument: 'fast' }, 'route.runModelCommand', ['fast']],
    [{ kind: 'preset', argument: 'relaxed' }, 'modes.runPresetCommand', ['relaxed']],
    [{ kind: 'jobs', argument: '2' }, 'work.runJobsCommand', ['2']],
    [{ kind: 'rename', title: 'Build' }, 'session.runRenameCommand', ['Build']],
    [{ kind: 'subagents', argument: 'writer' }, 'work.runSubagentsCommand', ['writer']],
    [{ kind: 'fork', title: 'From here' }, 'session.runForkCommand', ['From here']],
    [{ kind: 'new', title: 'Fresh' }, 'session.runNewCommand', ['Fresh']],
    [{ kind: 'reload' }, 'session.runReloadCommand', []],
    [{ kind: 'theme', argument: 'nord' }, 'appearance.runThemeCommand', ['nord']],
    [{ kind: 'history', argument: '' }, 'memory.runHistoryCommand', ['']],
    [{ kind: 'undo' }, 'staged.undo', []],
    [{ kind: 'redo' }, 'staged.redo', []],
    [{ kind: 'editor' }, 'terminal.editDraft', []],
  ] as const)('hands %s to the owner that holds it', (submission, name, args) => {
    const given = fixture()
    createCommands(given.ctx, given.ports).runSubmission(submission as Submission)

    expect(given.calls).toEqual([{ name, args }])
  })

  it.each([
    [{ kind: 'stash', argument: DRAFT }, 'stashEditor', [DRAFT]],
    [{ kind: 'stash-draft' }, 'stashEditor', []],
    [{ kind: 'stash-pop', selector: '1' }, 'pop', ['1']],
    [{ kind: 'stash-apply', selector: '1' }, 'apply', ['1']],
    [{ kind: 'stash-list' }, 'list', [String(SESSION)]],
    [{ kind: 'stash-drop', selector: '1' }, 'drop', ['1']],
    [{ kind: 'stash-clear' }, 'clear', []],
  ] as const)('routes %s to the parked-draft bank', (submission, method, args) => {
    const given = fixture()
    installStash(given)
    createCommands(given.ctx, given.ports).runSubmission(submission as Submission)

    expect(given.calls).toEqual([{ name: method, args }])
  })

  it('answers a blank /stash with its usage and parks nothing', () => {
    const given = fixture()
    installStash(given)
    createCommands(given.ctx, given.ports).runSubmission({ kind: 'stash', argument: '  ' })

    // The line the reader typed is already consumed, so the message has to name
    // the chord that can still hand the editor's own draft over.
    expect(given.notices).toEqual(['usage: /stash <draft>, or ctrl+x then s to park the editor'])
    expect(given.calls).toEqual([])
    expect(given.renders).toBe(0)
  })

  it.each([
    { kind: 'stash', argument: DRAFT },
    { kind: 'stash-draft' },
    { kind: 'stash-pop', selector: '1' },
    { kind: 'stash-apply', selector: '1' },
    { kind: 'stash-list' },
    { kind: 'stash-drop', selector: '1' },
    { kind: 'stash-clear' },
  ] as const)('keeps %s a no-op while the bank is unavailable', submission => {
    const given = fixture()
    createCommands(given.ctx, given.ports).runSubmission(submission as Submission)

    // The bank is late-bound behind storage; without it the command must stay
    // quiet rather than fail after the reader's line was already consumed.
    expect(given.calls).toEqual([])
    expect(given.notices).toEqual([])
  })
})

describe('createCommands host commands', () => {
  it('names an unknown command and the ones that exist', () => {
    const given = fixture()
    installRegistry(given, { listed: [command('plan'), command('status')] })
    createCommands(given.ctx, given.ports).runSubmission({ kind: 'command', name: 'nope', line: '/nope' })

    expect(given.notices).toEqual(['unknown command: /nope — ' + helpFor(['/plan', '/status'])])
    expect(given.renders).toBe(1)
  })

  it('refuses a command while the agent is still starting', () => {
    const given = fixture()
    installRegistry(given, { listed: [command('plan')] })
    given.driver = undefined
    createCommands(given.ctx, given.ports).runSubmission({ kind: 'command', name: 'plan', line: '/plan' })

    expect(given.notices).toEqual(['the agent is still starting; try again in a moment'])
    expect(given.calls).toEqual([])
    expect(given.renders).toBe(1)
  })

  it('treats a missing registry as an unknown command', () => {
    const given = fixture()
    createCommands(given.ctx, given.ports).runSubmission({ kind: 'command', name: 'plan', line: '/plan' })

    expect(given.notices).toEqual(['unknown command: /plan — ' + helpFor([])])
    expect(given.renders).toBe(1)
  })

  it.each([
    ['success', 'all good', '/plan all good'],
    ['success', undefined, '/plan done'],
    ['error', 'not in plan mode', '/plan failed: not in plan mode'],
    ['error', undefined, '/plan failed: no detail'],
  ] as const)('reports a %s result as %s', async (reply, text, notice) => {
    const given = fixture()
    installRegistry(given, { listed: [command('plan')], reply, text })
    createCommands(given.ctx, given.ports).runSubmission({ kind: 'command', name: 'plan', line: '/plan off' })
    await flush()

    expect(given.notices).toEqual([notice])
    expect(given.renders).toBe(1)
  })

  it('says nothing when the host reported no result at all', async () => {
    const given = fixture()
    installRegistry(given, { listed: [command('plan')], reply: 'none' })
    createCommands(given.ctx, given.ports).runSubmission({ kind: 'command', name: 'plan', line: '/plan' })
    await flush()

    expect(given.notices).toEqual([])
    expect(given.renders).toBe(0)
  })

  it.each([
    [new Error('the host blew up'), '/plan failed: the host blew up'],
    ['a bare string', '/plan failed: a bare string'],
  ] as const)('reports a dispatch that threw the string %s', async (failure, notice) => {
    const given = fixture()
    installRegistry(given, { listed: [command('plan')], failure })
    createCommands(given.ctx, given.ports).runSubmission({ kind: 'command', name: 'plan', line: '/plan' })
    await flush()

    expect(given.notices).toEqual([notice])
    expect(given.renders).toBe(1)
  })

  it('dispatches the typed line unchanged, with no attachments and its own signal', () => {
    const given = fixture()
    const registry = installRegistry(given, { listed: [command('plan')] })
    createCommands(given.ctx, given.ports).runSubmission({ kind: 'command', name: 'plan', line: '/plan off' })

    expect(registry.lookups).toEqual(['plan'])
    expect(registry.executions).toEqual([
      { line: '/plan off', attachments: [], signal: expect.any(AbortSignal) },
    ])
  })
})

describe('createCommands help', () => {
  it('lists the registered commands, the local ones, and the keys reaching them', () => {
    const given = fixture()
    installRegistry(given, { listed: [command('plan')] })
    createCommands(given.ctx, given.ports).runSubmission({ kind: 'help' })

    expect(given.notices).toEqual([helpFor(['/plan'])])
    expect(given.renders).toBe(1)
  })

  it('says none are registered while no registry answers either', () => {
    const given = fixture()
    createCommands(given.ctx, given.ports).runSubmission({ kind: 'help' })

    expect(given.notices).toEqual([helpFor([])])
  })

  it('says none are registered while no agent is driving', () => {
    const given = fixture()
    installRegistry(given, { listed: [command('plan')] })
    given.driver = undefined
    createCommands(given.ctx, given.ports).runSubmission({ kind: 'help' })

    expect(given.notices).toEqual([helpFor([])])
  })
})

describe('createCommands plan', () => {
  it.each([
    ['the controller reports it active', { active: true }, false, '/plan off'],
    ['a selection waits for the turn boundary', { active: false, pending: true }, false, '/plan off'],
    ['no controller answers and the fold says on', undefined, true, '/plan off'],
    ['no controller answers and the fold says off', undefined, false, '/plan'],
  ] as const)('asks for the other state when %s', (_label, controller, fold, line) => {
    const given = fixture()
    const registry = installRegistry(given, { listed: [command('plan')] })
    if (controller !== undefined) given.services.set('planMode', { get: () => controller })
    given.planMode = fold
    createCommands(given.ctx, given.ports).runSubmission({ kind: 'plan' })

    expect(registry.executions.map(execution => execution.line)).toEqual([line])
  })

  it('refuses the plan chord while no agent is driving', () => {
    const given = fixture()
    installRegistry(given, { listed: [command('plan')] })
    given.driver = undefined
    createCommands(given.ctx, given.ports).runSubmission({ kind: 'plan' })

    expect(given.notices).toEqual(['the agent is still starting; try again in a moment'])
  })
})

describe('createCommands status', () => {
  it.each([
    [
      'every fact',
      facts({
        provider: 'deepseek',
        model: 'chat',
        effort: 'high',
        agentPreset: 'code',
        preset: 'default',
        contextTokens: 1000,
        contextWindow: 128000,
        uncachedInputTokens: 1200,
        outputTokens: 300,
      }),
      false,
      'session ' + SESSION + ' · viewing ' + VIEWED + ' · model deepseek/chat (high) · mode code · permissions default · context ' + formatTokens(1000) + '/' + formatTokens(128000) + ' · tokens in ' + formatTokens(1200) + ' out ' + formatTokens(300) + ' · cwd /w',
    ],
    [
      'a child on screen and a route with no provider',
      facts({ model: 'chat' }),
      true,
      'session ' + SESSION + ' · model chat · cwd /w',
    ],
    [
      'a context with no window and only output tokens',
      facts({ contextTokens: 500, outputTokens: 300 }),
      false,
      'session ' + SESSION + ' · viewing ' + VIEWED + ' · context ' + formatTokens(500) + ' · tokens in ' + formatTokens(0) + ' out ' + formatTokens(300) + ' · cwd /w',
    ],
    [
      'output tokens with no prompt-side count',
      facts({ outputTokens: 300 }),
      false,
      'session ' + SESSION + ' · viewing ' + VIEWED + ' · tokens in ' + formatTokens(0) + ' out ' + formatTokens(300) + ' · cwd /w',
    ],
    [
      'a prompt-side count with no output yet',
      facts({ uncachedInputTokens: 1200 }),
      false,
      'session ' + SESSION + ' · viewing ' + VIEWED + ' · tokens in ' + formatTokens(1200) + ' out ' + formatTokens(0) + ' · cwd /w',
    ],
  ] as const)('states %s', (_label, read, viewingChild, expected) => {
    const given = fixture()
    given.facts = read
    given.viewingChild = viewingChild
    createCommands(given.ctx, given.ports).runSubmission({ kind: 'status' })

    expect(given.notices).toEqual([expected])
    expect(given.renders).toBe(1)
  })
})

describe('createCommands copy', () => {
  it('says there is nothing to copy while no answer has landed', () => {
    const given = fixture()
    given.entries = [{ kind: 'user', text: 'ask' }, { kind: 'notice', text: 'noted' }]
    createCommands(given.ctx, given.ports).runSubmission({ kind: 'copy' })

    expect(given.notices).toEqual(['nothing to copy yet'])
    expect(given.calls).toEqual([])
    expect(given.renders).toBe(1)
  })

  it('writes the last answer through the terminal clipboard', () => {
    const given = fixture()
    given.entries = [
      { kind: 'assistant', text: 'first' },
      { kind: 'user', text: 'again' },
      { kind: 'assistant', text: ANSWER },
    ]
    createCommands(given.ctx, given.ports).runSubmission({ kind: 'copy' })

    expect(given.calls).toEqual([
      { name: 'terminal.terminal.write', args: [clipboardSequence(ANSWER)] },
    ])
    expect(given.notices).toEqual(['copied ' + ANSWER.length + ' characters through the terminal'])
  })
})

describe('createCommands todo', () => {
  it('says no list has been written when the session kept none', () => {
    const given = fixture()
    createCommands(given.ctx, given.ports).runSubmission({ kind: 'todo' })

    expect(given.notices).toEqual(['no todo list has been written in this session'])
    expect(given.renders).toBe(1)
  })

  it('shows the list the agent kept, in the order work is read', () => {
    const given = fixture()
    given.todos = [
      { content: 'done already', status: 'completed' },
      { content: 'being written', status: 'in_progress' },
    ]
    createCommands(given.ctx, given.ports).runSubmission({ kind: 'todo' })

    expect(given.notices).toEqual([describeTodos(given.todos)])
  })
})

describe('createCommands export', () => {
  it('writes the visible transcript and tells the reader where', () => {
    const given = fixture()
    given.entries = [{ kind: 'user', text: 'ask' }, { kind: 'assistant', text: 'answer' }]
    const path = join(scratch(), 'dump.md')
    createCommands(given.ctx, given.ports).runSubmission({ kind: 'export', path })

    expect(readFileSync(path, 'utf8')).toBe(transcriptToText(given.entries))
    expect(given.notices).toEqual(['transcript written to ' + path])
    expect(given.renders).toBe(1)
  })

  it('writes a dump with no destination into the themes home, never the working directory', () => {
    const given = fixture()
    given.entries = [{ kind: 'user', text: 'ask' }]
    const home = scratch()
    vi.stubEnv('DSH_HOME', home)

    createCommands(given.ctx, given.ports).runSubmission({ kind: 'export', path: '' })

    // The themes home is the one directory this surface creates under the
    // harness home, so the dump lands beside files the reader already knows —
    // and the directory the terminal was started in stays clean.
    const path = join(home, THEMES_DIR_NAME, defaultExportFile(SESSION))
    expect(readFileSync(path, 'utf8')).toBe(transcriptToText(given.entries))
    expect(given.notices).toEqual(['transcript written to ' + path])
    expect(existsSync(join(process.cwd(), defaultExportFile(SESSION)))).toBe(false)
  })

  it('keeps an unwritable dump a notice rather than a failure', () => {
    const given = fixture()
    const path = join(scratch(), 'gone', 'dump.md')
    createCommands(given.ctx, given.ports).runSubmission({ kind: 'export', path })

    // The prefix is this module's; the tail is the filesystem's own words, which
    // a refusal must not paraphrase away.
    expect(given.notices).toHaveLength(1)
    expect(given.notices[0]?.startsWith('could not write ' + path + ': ')).toBe(true)
    expect(given.renders).toBe(1)
  })
})

describe('createCommands clear', () => {
  it('empties the transcript the reader sees', () => {
    const given = fixture()
    createCommands(given.ctx, given.ports).runSubmission({ kind: 'clear' })

    expect(given.calls).toEqual([{ name: 'transcript.reset', args: [] }])
    expect(given.renders).toBe(1)
  })
})

describe('createCommands prompt', () => {
  it('refuses a prompt while the agent is still starting', () => {
    const given = fixture()
    given.driver = undefined
    createCommands(given.ctx, given.ports).runSubmission({ kind: 'prompt', text: 'hello' })

    expect(given.notices).toEqual(['the agent is still starting; try again in a moment'])
    expect(given.calls).toEqual([])
    expect(given.renders).toBe(1)
  })

  it('steers the running turn instead of opening another', () => {
    const given = fixture()
    given.turnRunning = true
    createCommands(given.ctx, given.ports).runSubmission({ kind: 'prompt', text: 'wait' })

    expect(given.calls).toEqual([{ name: 'driver.steer', args: ['wait'] }])
  })

  it('adopts the default route before it stages a new turn', () => {
    const given = fixture()
    createCommands(given.ctx, given.ports).runSubmission({ kind: 'prompt', text: 'go' })

    // Order is the contract: a turn opened on a route the session had not
    // adopted would run on whichever model the last session left behind.
    expect(given.calls).toEqual([
      { name: 'route.adoptDefault', args: [] },
      { name: 'staged.send', args: ['go'] },
    ])
  })
})

describe('createCommands keys', () => {
  it('names the layers when the asked-for one does not exist', () => {
    const given = fixture()
    createCommands(given.ctx, given.ports).runSubmission({ kind: 'keys', argument: 'gate2' })

    expect(given.notices).toEqual(['unknown layer "gate2" · ' + KEYMAP_LAYERS.join(' ')])
    expect(given.calls).toEqual([])
    expect(given.renders).toBe(1)
  })

  it('opens the map narrowed to the named layer, over the surface', () => {
    const given = fixture()
    createCommands(given.ctx, given.ports).runSubmission({ kind: 'keys', argument: 'prompt' })

    expect(given.placement).toBe('popup')
    expect(given.calls.map(call => call.name)).toEqual(['modals.openPicker'])
    const rows = given.picker?.card().rows ?? []
    expect(rows.some(row => row.description === 'prompt')).toBe(true)
    expect(rows.some(row => row.description === 'chord')).toBe(false)
  })

  it('opens the whole map when no layer was named', () => {
    const given = fixture()
    createCommands(given.ctx, given.ports).runSubmission({ kind: 'keys', argument: '' })

    const rows = given.picker?.card().rows ?? []
    expect(rows.some(row => row.description === 'chord')).toBe(true)
  })
})

describe('createCommands resume', () => {
  it('says there is nothing to resume without session storage', async () => {
    const given = fixture()
    createCommands(given.ctx, given.ports).runSubmission({ kind: 'resume' })
    await flush()

    expect(given.notices).toEqual(['this profile has no session storage, so there is nothing to resume'])
    expect(given.calls).toEqual([])
  })

  it('reports a listing that failed instead of pretending it was empty', async () => {
    const given = fixture()
    installPersistence(given)
    given.listError = new Error('storage offline')
    createCommands(given.ctx, given.ports).runSubmission({ kind: 'resume' })
    await flush()

    expect(given.notices).toEqual(['could not list stored sessions: storage offline'])
    expect(given.renders).toBe(1)
  })

  it('says the history holds nothing to resume', async () => {
    const given = fixture()
    installPersistence(given)
    given.stored = []
    createCommands(given.ctx, given.ports).runSubmission({ kind: 'resume' })
    await flush()

    expect(given.notices).toEqual(['no stored sessions to resume'])
  })

  it('switches to the session the reader picked', async () => {
    const given = fixture()
    installPersistence(given)
    given.stored = [{ header: { id: STORED, createdAt: 1 }, eventCount: 2 }]
    given.pickerReply = STORED
    createCommands(given.ctx, given.ports).runSubmission({ kind: 'resume' })
    await flush()

    expect(given.calls.filter(call => call.name === 'session.switchSession')).toEqual([
      { name: 'session.switchSession', args: [SessionId(STORED)] },
    ])
  })

  it.each([
    [new Error('pick failed'), 'could not resume: pick failed'],
    ['a bare string', 'could not resume: a bare string'],
  ] as const)('reports the picker rejecting with %s', async (pickerError, notice) => {
    const given = fixture()
    installPersistence(given)
    given.stored = [{ header: { id: STORED, createdAt: 1 } }]
    given.pickerError = pickerError
    createCommands(given.ctx, given.ports).runSubmission({ kind: 'resume' })
    await flush()

    expect(given.notices).toEqual([notice])
    expect(given.renders).toBe(1)
  })

  it('refuses a stored session the run mode named on the command line cannot open', async () => {
    const given = fixture()
    installPersistence(given)
    given.stored = [{ header: { id: STORED, createdAt: 1 } }]
    given.preset = 'code'
    given.presetRoster = { serviceFor: () => undefined }
    given.presetForError = new Error('code is not offered by this run')
    given.vetoOn = STORED
    createCommands(given.ctx, given.ports).runSubmission({ kind: 'resume' })
    await flush()

    expect(given.vetoReason).toBe('code is not offered by this run')
    expect(given.calls.filter(call => call.name === 'modes.presetFor')).toEqual([
      { name: 'modes.presetFor', args: [SessionId(STORED), true, undefined] },
    ])
    expect(given.calls.some(call => call.name === 'session.switchSession')).toBe(false)
  })

  it('asks no roster for a conflict when this run named no mode', async () => {
    const given = fixture()
    installPersistence(given)
    given.stored = [{ header: { id: STORED, createdAt: 1 } }]
    given.presetForError = new Error('never asked')
    given.vetoOn = STORED
    given.pickerReply = STORED
    createCommands(given.ctx, given.ports).runSubmission({ kind: 'resume' })
    await flush()

    expect(given.vetoReason).toBeUndefined()
    expect(given.calls.some(call => call.name === 'modes.presetFor')).toBe(false)
  })
})

describe('createCommands start', () => {
  it('tells the reader what is missing before it takes the screen, then opens the launch', async () => {
    const given = fixture()
    given.missing = 'the timeline row is unavailable'
    given.drift = 'the installed skill is older than this build'
    await createCommands(given.ctx, given.ports).start()

    // The alt screen closes over the shell's own output, so anything the reader
    // must know about the composition has to print before the screen is taken.
    expect(given.order).toEqual([
      'notice',
      'notice',
      'modes.validateLaunch',
      'terminal.tui.start',
      'terminal.writeTerminal',
      'terminal.herdr.publish',
      'appearance.openNotices',
      'session.openAgent',
    ])
    expect(given.notices).toEqual(['the timeline row is unavailable', 'the installed skill is older than this build'])
    expect(given.calls.find(call => call.name === 'terminal.writeTerminal')?.args).toEqual([
      windowTitle(process.cwd(), 'ready'),
    ])
    expect(given.calls.find(call => call.name === 'session.openAgent')?.args).toEqual([SESSION, false])
  })

  it('stays quiet when the composition has nothing to report', async () => {
    const given = fixture()
    await createCommands(given.ctx, given.ports).start()

    expect(given.notices).toEqual([])
  })

  it('prints a settings refusal through the transcript once the screen is owned', async () => {
    const given = fixture()
    await createCommands(given.ctx, given.ports).start()

    given.sink?.('mousemove could not be bound')
    expect(given.notices).toEqual(['mousemove could not be bound'])
  })

  it('refuses a launch whose named mode this composition cannot offer, before taking the screen', async () => {
    const given = fixture()
    given.validateError = new Error('mode code is not offered by this run')

    await expect(createCommands(given.ctx, given.ports).start()).rejects.toThrow('mode code is not offered by this run')
    expect(given.calls.map(call => call.name)).toEqual(['modes.validateLaunch'])
    expect(given.calls.some(call => call.name === 'terminal.tui.start')).toBe(false)
  })

  it('opens the session a bare --resume picked, as a resume', async () => {
    const given = fixture()
    given.launch = { sessionId: SESSION, resume: false, resumePicker: true }
    installPersistence(given)
    given.stored = [{ header: { id: STORED, createdAt: 1 } }]
    given.pickerReply = STORED
    await createCommands(given.ctx, given.ports).start()

    expect(given.calls.find(call => call.name === 'session.openAgent')?.args).toEqual([SessionId(STORED), true])
  })

  it('exits cleanly when the reader cancelled the resume list', async () => {
    const given = fixture()
    given.launch = { sessionId: SESSION, resume: false, resumePicker: true }
    installPersistence(given)
    given.stored = [{ header: { id: STORED, createdAt: 1 } }]
    given.pickerReply = undefined
    await createCommands(given.ctx, given.ports).start()

    expect(given.calls.find(call => call.name === 'terminal.requestExit')?.args).toEqual([0])
    expect(given.calls.some(call => call.name === 'session.openAgent')).toBe(false)
  })

  it('honours the resume flag a plain launch carried', async () => {
    const given = fixture()
    given.launch = { sessionId: SESSION, resume: true, resumePicker: false }
    await createCommands(given.ctx, given.ports).start()

    expect(given.calls.find(call => call.name === 'session.openAgent')?.args).toEqual([SESSION, true])
  })
})
