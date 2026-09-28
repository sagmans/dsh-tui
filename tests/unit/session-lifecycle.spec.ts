/**
 * The session's lifecycle owner: which agent this terminal drives, what a
 * replacement costs, and what the reader is told when a transition cannot
 * happen.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { forkPoint, type ForkEvent } from '@/agent/fork.ts'
import { SESSION_START_REASONS } from '@/herdr/constants.ts'
import type { HerdrReporter } from '@/herdr/reporter.ts'
import {
  createSessionLifecycle,
  type LiveSession,
  type SessionLifecycle,
  type SessionLifecyclePorts,
} from '@/surface/session-lifecycle.ts'
import { BELL } from '@/terminal/bell.ts'
import { windowTitle } from '@/terminal/title.ts'

const SESSION_A = 'tui-session-a' as SessionId
const SESSION_B = 'tui-session-b' as SessionId
const CHILD = 'tui-session-child' as SessionId
/** README promises a bell at the ten-second turn boundary. */
const BELL_DOCUMENTED_THRESHOLD_MS = 10_000

/** The prefix every session this surface creates carries, so a reader can tell it apart. */
const NEW_SESSION_PREFIX = 'tui-session-'

/** How often the running-state clock repaints, which the module keeps to itself. */
const STATUS_TICK_MS = 1000

/** The route the port answers with when asked for a session's mode. */
const PRESET = 'dsh-plan'

/** Let the microtask chain a void-ed command runs on finish. */
const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

/** Everything the lifecycle reaches in the surface around it, recorded in call order. */
interface Fixture {
  readonly lifecycle: SessionLifecycle
  readonly ports: SessionLifecyclePorts
  /** Port calls and reports, in the order the module made them. */
  readonly trace: string[]
  readonly notices: string[]
  readonly renders: () => number
  readonly written: string[]
  readonly catalog: unknown[]
  /** Options the host was asked to resume with, newest last. */
  readonly resumed: Record<string, unknown>[]
  /** Options the host was asked to create with, newest last. */
  readonly created: Record<string, unknown>[]
  readonly disposed: () => number
  /** Refuse the next mode the reader asks for, the way a broken composition file does. */
  readonly refusePreset: (error: unknown) => void
  /** The mode a session settles on, which a profile may leave unsaid. */
  readonly setPreset: (preset: string | undefined) => void
  readonly setBell: (on: boolean) => void
  readonly setExiting: (on: boolean) => void
  readonly setLive: (session: LiveSession) => void
  readonly setInbox: (inbox: unknown) => void
  readonly setEvents: (id: SessionId, events: readonly ForkEvent[]) => void
  readonly setRenames: (service: { rename?: (session: unknown, title: string) => { title?: string } } | undefined) => void
  readonly delivery: (event: string, payload: unknown) => void
  readonly dispose: () => void
}

function fixture(): Fixture {
  const trace: string[] = []
  const notices: string[] = []
  const written: string[] = []
  const catalog: unknown[] = []
  const resumed: Record<string, unknown>[] = []
  const created: Record<string, unknown>[] = []
  const listeners = new Map<string, (payload: unknown) => void>()
  const events = new Map<string, readonly ForkEvent[]>()
  let disposed = 0
  let renders = 0
  let bell = true
  let exiting = false
  let live: LiveSession | undefined
  let inbox: unknown
  let renameService: { rename?: (session: unknown, title: string) => { title?: string } } | undefined
  let preset: string | undefined = PRESET
  let refusal: { readonly value: unknown } | undefined

  // The agent scope a preset mounts into: the host hands it to the module's own
  // setup callback, which is where the route and the preset are installed.
  const agentCtx = {} as Context
  const handleFor = (id: SessionId) => ({
    sessionId: id,
    agent: { id, status: 'idle' },
    dispose: async () => {
      disposed += 1
    },
  })
  const agents = {
    create: async (options: Record<string, unknown>) => {
      created.push(options)
      await (options.setup as ((ctx: Context) => void) | undefined)?.(agentCtx)
      return handleFor(options.sessionId as SessionId)
    },
    resume: async (options: Record<string, unknown>) => {
      resumed.push(options)
      await (options.setup as ((ctx: Context) => void) | undefined)?.(agentCtx)
      return handleFor(options.resumeSessionId as SessionId)
    },
  }
  const ctx = {
    agents,
    get: (name: string) => {
      if (name === 'sessionTitle') return renameService
      if (name === 'sessions') return { get: (id: SessionId) => ({ id }) }
      if (name === 'sessionProjections') return { stateOf: (_session: unknown, key: string) => (key === 'inbox' ? inbox : undefined) }
      return undefined
    },
    on: (event: string, handler: (payload: unknown) => void) => {
      listeners.set(event, handler)
      return () => {}
    },
  } as unknown as Context

  const disposers: (() => void)[] = []
  const herdr: HerdrReporter = {
    enabled: false,
    driver: status => trace.push(`driver:${status}`),
    session: input => trace.push(`session:${input.reason}:${input.id}:${input.cwd}`),
    background: () => {},
    block: () => {},
    unblock: () => {},
    publish: () => {},
    releaseSync: () => {},
    release: async () => {},
    registerExitRelease: () => () => {},
  }
  const ports: SessionLifecyclePorts = {
    initialSession: SESSION_A,
    model: 'kimi-k3',
    provider: 'kimi-coding',
    bell,
    presetFor: async (id, resume, fork) => {
      trace.push(`presetFor:${id}:${String(resume)}:${String(fork !== undefined)}`)
      if (refusal !== undefined) throw refusal.value
      return preset
    },
    installModelChoice: () => trace.push('installModelChoice'),
    mountPreset: async (_agentCtx, preset) => {
      trace.push(`mountPreset:${preset}`)
    },
    liveSession: () => live,
    installCompletion: () => trace.push('installCompletion'),
    sessionEvents: async id => events.get(id) ?? [],
    setViewed: id => trace.push(`setViewed:${id}`),
    setPresentScope: () => trace.push('setPresentScope'),
    clearPresentScope: () => trace.push('clearPresentScope'),
    resetTranscript: () => trace.push('resetTranscript'),
    replay: async id => {
      trace.push(`replay:${id}`)
    },
    fold: async id => {
      trace.push(`fold:${id}`)
      return 0
    },
    notice: message => notices.push(message),
    render: () => {
      renders += 1
    },
    promptMemorySessionOpened: () => trace.push('promptMemorySessionOpened'),
    stagedSessionOpened: id => trace.push(`stagedSessionOpened:${id}`),
    turnSettled: () => trace.push('turnSettled'),
    acceptCatalog: info => catalog.push(info),
    resetRoster: () => trace.push('resetRoster'),
    refreshJobs: () => trace.push('refreshJobs'),
    herdr,
    writeTerminal: text => {
      written.push(text)
    },
    exiting: () => exiting,
    disposers,
  }
  // The courtesy is read through a getter like every other live read, so a case
  // can turn it off without rebuilding the surface.
  Object.defineProperty(ports, 'bell', { get: () => bell })

  return {
    lifecycle: createSessionLifecycle(ctx, ports),
    ports,
    trace,
    notices,
    renders: () => renders,
    written,
    catalog,
    resumed,
    created,
    disposed: () => disposed,
    refusePreset: error => {
      refusal = error === undefined ? undefined : { value: error }
    },
    setPreset: value => {
      preset = value
    },
    setBell: on => {
      bell = on
    },
    setExiting: on => {
      exiting = on
    },
    setLive: session => {
      live = session
    },
    setInbox: value => {
      inbox = value
    },
    setEvents: (id, log) => {
      events.set(id, log)
    },
    setRenames: service => {
      renameService = service
    },
    delivery: (event, payload) => listeners.get(event)?.(payload),
    dispose: () => {
      for (const disposer of [...disposers].reverse()) disposer()
    },
  }
}

/** A prompt the harness holds in a session's inbox. */
const queued = (text: string, kind = 'user'): unknown => ({
  source: { kind },
  content: [{ type: 'text', text }],
})
describe('createSessionLifecycle', () => {
  it('starts with no agent, nothing open and no turn running', () => {
    const given = fixture()

    expect(given.lifecycle.activeSession()).toBe(SESSION_A)
    expect(given.lifecycle.drivingAgent()).toBeUndefined()
    expect(given.lifecycle.sessionOpened()).toBe(false)
    expect(given.lifecycle.turnRunning()).toBe(false)
    expect(given.lifecycle.activity()).toEqual({ running: false, startedAt: undefined })
    // An exit hint may only name a session the surface really opened.
    expect(given.lifecycle.queuedPrompts()).toEqual([])
  })

  it('opens a session in the order its world has to exist in', async () => {
    const given = fixture()

    const handle = await given.lifecycle.openAgent(SESSION_A, false)

    // The preset settles before the transcript is touched, the preset mounts
    // before the fold reads cards through it, the driver's own phase is read out
    // before the identity that carries it, and the completion is re-armed
    // against the world the new agent mounted.
    expect(given.trace).toEqual([
      `presetFor:${SESSION_A}:false:false`,
      'installModelChoice',
      `mountPreset:${PRESET}`,
      `setViewed:${SESSION_A}`,
      'refreshJobs',
      `stagedSessionOpened:${SESSION_A}`,
      'promptMemorySessionOpened',
      'driver:idle',
      `session:${SESSION_START_REASONS.startup}:${SESSION_A}:${process.cwd()}`,
      'setPresentScope',
      'installCompletion',
    ])
    expect(given.created).toHaveLength(1)
    expect(given.created[0]).toMatchObject({
      sessionId: SESSION_A,
      agentOptions: { provider: 'kimi-coding', model: 'kimi-k3' },
      meta: { cwd: process.cwd(), agentPreset: PRESET },
    })
    expect(given.notices).toEqual([`session ${SESSION_A}`])
    expect(given.renders()).toBe(1)
    expect(given.lifecycle.drivingAgent()).toBe(handle)
    expect(given.lifecycle.sessionOpened()).toBe(true)
  })

  it('mounts no mode and records none when the profile settles on no preset', async () => {
    const given = fixture()
    given.setPreset(undefined)

    await given.lifecycle.openAgent(SESSION_A, false)

    // A profile that selects no preset still opens: the agent runs on the
    // deployment default, and a session header naming a preset it never mounted
    // would make every later resume read the wrong mode.
    expect(given.trace).not.toContain('mountPreset:undefined')
    expect(given.created[0]?.meta).not.toHaveProperty('agentPreset')
    expect(given.lifecycle.activeSession()).toBe(SESSION_A)
  })

  it('reports a failure that was not thrown as an Error', async () => {
    const given = fixture()
    await given.lifecycle.openAgent(SESSION_A, false)
    given.refusePreset('the composition file says no')

    given.lifecycle.runNewCommand('')
    await flush()
    // A profile row that refuses with a plain string still has to say something
    // the reader can act on rather than an empty reason.
    expect(given.notices.at(-1)).toBe('could not start a session: the composition file says no')

    given.refusePreset(undefined)
    await given.lifecycle.openAgent(SESSION_A, false)
    given.refusePreset('the composition file says no')
    given.lifecycle.runReloadCommand()
    await flush()
    expect(given.notices.at(-1)).toBe(
      'could not reload: the composition file says no — fix the composition and /reload again',
    )

    given.refusePreset(undefined)
    await given.lifecycle.openAgent(SESSION_A, false)
    given.refusePreset('the composition file says no')
    given.setEvents(SESSION_A, [{ type: 'turn/end', seq: 1 }])
    given.lifecycle.runForkCommand('')
    await flush()
    expect(given.notices.at(-1)).toBe('could not fork: the composition file says no')
  })

  it('reports a rename that was not thrown as an Error', () => {
    const given = fixture()
    given.setRenames({
      rename: () => {
        throw 'the title service is gone'
      },
    })

    given.lifecycle.runRenameCommand('mine')

    expect(given.notices.at(-1)).toBe('could not rename: the title service is gone')
  })

  it('settles a turn boundary that arrived with no turn this surface saw open', () => {
    const given = fixture()

    given.lifecycle.observe({ id: SESSION_A }, { type: 'turn/end' })

    // A resumed session's own turn may have started before this surface
    // attached, and a start time nobody saw must not read as a turn that ran for
    // the age of the process.
    expect(given.written).toEqual([windowTitle(process.cwd(), 'ready')])
    expect(given.lifecycle.activity()).toEqual({ running: false, startedAt: undefined })
    expect(given.trace).toContain('turnSettled')
  })

  it('resumes through the host and replays only once the agent exists', async () => {
    const given = fixture()

    await given.lifecycle.openAgent(SESSION_A, true)

    // The fold reads every card through the scope the preset mounted, so it runs
    // after the handle is in service; the report says the session returned to
    // the reader rather than that it started.
    expect(given.trace).toEqual([
      `presetFor:${SESSION_A}:true:false`,
      'installModelChoice',
      `mountPreset:${PRESET}`,
      `setViewed:${SESSION_A}`,
      'refreshJobs',
      `stagedSessionOpened:${SESSION_A}`,
      'promptMemorySessionOpened',
      'driver:idle',
      `session:${SESSION_START_REASONS.resume}:${SESSION_A}:${process.cwd()}`,
      'setPresentScope',
      `replay:${SESSION_A}`,
      'installCompletion',
    ])
    expect(given.resumed[0]).toMatchObject({ resumeSessionId: SESSION_A })
    expect(given.notices).toEqual([`session ${SESSION_A} (resumed)`])
  })

  it('hands a fork its inherited prefix and folds the branch it opened on', async () => {
    const given = fixture()
    const log: readonly ForkEvent[] = [
      { type: 'user/message', seq: 1 },
      { type: 'turn/end', seq: 2 },
      { type: 'turn/start', seq: 3 },
    ]
    const point = forkPoint(log)
    if (point === undefined) throw new Error('the fixture log has no completed turn to cut at')

    await given.lifecycle.openAgent(CHILD, false, { from: SESSION_A, events: log })

    // A branch inherits the conversation the reader was already reading, so the
    // host is told every event the caller cut carries and the parent it came
    // from, and the viewer folds it rather than opening on an empty screen.
    expect(given.created[0]).toMatchObject({
      seed: log,
      meta: { parentSession: SESSION_A, isSeeded: true },
    })
    expect(given.trace).toContain(`fold:${CHILD}`)
    expect(given.trace).toContain(`session:${SESSION_START_REASONS.fork}:${CHILD}:${process.cwd()}`)
  })

  it('refuses to touch the transcript when the session mode cannot be settled', async () => {
    const given = fixture()
    given.refusePreset(new Error('preset "probe" is not installed'))

    await expect(given.lifecycle.openAgent(CHILD, false)).rejects.toThrow('preset "probe" is not installed')

    // A refusal has to leave neither a half-replayed session nor a half-composed
    // agent behind: the reader keeps the session they had.
    expect(given.created).toEqual([])
    expect(given.trace).toEqual([`presetFor:${CHILD}:false:false`])
    expect(given.notices).toEqual([])
    expect(given.renders()).toBe(0)
    expect(given.lifecycle.activeSession()).toBe(SESSION_A)
    expect(given.lifecycle.sessionOpened()).toBe(false)
  })

  it('leaves the session exactly as it was when a switch is refused', async () => {
    const given = fixture()
    const handle = await given.lifecycle.openAgent(SESSION_A, false)

    given.trace.length = 0
    given.refusePreset(new Error('the composition file is broken'))
    await expect(given.lifecycle.switchSession(SESSION_B)).rejects.toThrow('the composition file is broken')

    // The new session settles before the outgoing agent is let go, so a
    // refusal leaves the same agent driving the same session, with the screen
    // and the roster it was already showing.
    expect(handle.sessionId).toBe(SESSION_A)
    expect(given.lifecycle.drivingAgent()).toBe(handle)
    expect(given.lifecycle.activeSession()).toBe(SESSION_A)
    expect(given.disposed()).toBe(0)
    expect(given.trace).toEqual([`presetFor:${SESSION_B}:true:false`])
  })

  it('switches on a retry after a refusal, stopping the outgoing agent once', async () => {
    const given = fixture()
    await given.lifecycle.openAgent(SESSION_A, false)

    given.refusePreset(new Error('the composition file is broken'))
    await expect(given.lifecycle.switchSession(SESSION_B)).rejects.toThrow('the composition file is broken')

    // The refusal above took nothing away, so the retry is an ordinary switch
    // rather than a repair of a surface with no agent driving it.
    given.refusePreset(undefined)
    await given.lifecycle.switchSession(SESSION_B)

    expect(given.lifecycle.drivingAgent()?.sessionId).toBe(SESSION_B)
    expect(given.lifecycle.activeSession()).toBe(SESSION_B)
    expect(given.disposed()).toBe(1)
    expect(given.notices.at(-1)).toBe(`session ${SESSION_B} (resumed)`)
  })

  it('switches session by settling the new open before the outgoing agent goes', async () => {
    const given = fixture()
    await given.lifecycle.openAgent(SESSION_A, false)
    given.trace.length = 0

    await given.lifecycle.switchSession(SESSION_B)

    // The mode is asked for and composed while the outgoing agent still drives;
    // its scope, transcript and roster only go once the new session is
    // accepted, so the replay that follows folds into a cleared screen.
    expect(given.trace.slice(0, 6)).toEqual([
      `presetFor:${SESSION_B}:true:false`,
      'installModelChoice',
      `mountPreset:${PRESET}`,
      'clearPresentScope',
      'resetTranscript',
      'resetRoster',
    ])
    expect(given.disposed()).toBe(1)
    expect(given.lifecycle.activeSession()).toBe(SESSION_B)
    expect(given.notices.at(-1)).toBe(`session ${SESSION_B} (resumed)`)
  })

  it('stops the agent it let go of, and stops it once', async () => {
    const given = fixture()
    await given.lifecycle.openAgent(SESSION_A, false)

    await given.lifecycle.disposeOutgoing()
    await given.lifecycle.disposeOutgoing()

    expect(given.disposed()).toBe(1)
    expect(given.lifecycle.drivingAgent()).toBeUndefined()
    // The outgoing turn's clock dies with its agent: a session joined afterwards
    // must not be timed by work it never ran.
    expect(given.lifecycle.activity()).toEqual({ running: false, startedAt: undefined })
  })

  it('disposes the agent in service when the surface tears down', async () => {
    const given = fixture()
    await given.lifecycle.openAgent(SESSION_A, false)

    given.dispose()
    await flush()

    // A teardown that left the loop running would keep a session alive past the
    // screen that owns it.
    expect(given.disposed()).toBe(1)
  })

  it('refuses to start a new session while the first agent is still starting', () => {
    const given = fixture()

    given.lifecycle.runNewCommand('')

    expect(given.notices).toEqual(['the agent is still starting; try again in a moment'])
    expect(given.renders()).toBe(1)
    expect(given.created).toEqual([])
  })

  it('starts a fresh session in place, and titles it when the reader asked for one', async () => {
    const given = fixture()
    const renamed: { readonly session: unknown; readonly title: string }[] = []
    given.setRenames({
      rename: (session, title) => {
        renamed.push({ session, title })
        return { title }
      },
    })
    await given.lifecycle.openAgent(SESSION_A, false)
    given.trace.length = 0

    given.lifecycle.runNewCommand('the new work')
    await flush()

    const opened = given.lifecycle.activeSession()
    expect(String(opened).startsWith(NEW_SESSION_PREFIX)).toBe(true)
    expect(opened).not.toBe(SESSION_A)
    // The replacement joins a surface the outgoing agent no longer writes to,
    // without the terminal ever leaving the alternate screen.
    expect(given.trace.slice(0, 3)).toEqual(['resetTranscript', 'resetRoster', `presetFor:${opened}:false:false`])
    expect(given.created[1]).toMatchObject({ sessionId: opened })
    expect(renamed).toEqual([{ session: { id: opened }, title: 'the new work' }])
    // The title reaches the picker first, so the notice that follows names the
    // session the reader will see in it.
    expect(given.notices.slice(-2)).toEqual([`session renamed to "the new work"`, 'started a new session'])
  })

  it('starts a new session with no title when the reader gave none', async () => {
    const given = fixture()
    const renamed: unknown[] = []
    given.setRenames({
      rename: (_session, title) => {
        renamed.push(title)
        return {}
      },
    })
    await given.lifecycle.openAgent(SESSION_A, false)

    given.lifecycle.runNewCommand('')
    await flush()

    // The rename is what a reader asked for, not what every new session needs:
    // an unnamed one keeps the picker's own derived name.
    expect(renamed).toEqual([])
    expect(given.notices.at(-1)).toBe('started a new session')

    const opened = given.lifecycle.activeSession()
    given.setEvents(opened, [{ type: 'turn/end', seq: 1 }])
    given.lifecycle.runForkCommand('')
    await flush()

    expect(renamed).toEqual([])
    expect(given.notices.at(-1)).toBe(`forked from ${opened} at event 1 — 1 inherited`)
  })

  it('reports a session that could not be started instead of throwing out of the command', async () => {
    const given = fixture()
    await given.lifecycle.openAgent(SESSION_A, false)
    given.refusePreset(new Error('no preset is installed'))

    given.lifecycle.runNewCommand('')
    await flush()

    expect(given.notices).toEqual([`session ${SESSION_A}`, 'could not start a session: no preset is installed'])
    // The old agent is gone and no new one exists, which the reader is told
    // rather than being left typing into a surface that answers nothing.
    expect(given.lifecycle.drivingAgent()).toBeUndefined()
  })

  it('refuses to reload a surface that has not opened its first session', async () => {
    const given = fixture()

    given.lifecycle.runReloadCommand()
    await flush()

    expect(given.notices).toEqual(['the agent is still starting; try again in a moment'])
    expect(given.renders()).toBe(1)
  })

  it.each([
    {
      name: 'a turn is running',
      inbox: undefined,
      turn: true,
      expected: 'a turn is running — ctrl+c interrupts it first (delivered text is kept), then /reload',
    },
    {
      name: 'one prompt is queued',
      inbox: { 'next-turn': [queued('hello')] },
      turn: false,
      expected: '1 queued prompt would be dropped — ctrl+c hands them back to the bar, then /reload',
    },
    {
      name: 'two prompts are queued',
      inbox: { 'next-step': [queued('one')], 'next-turn': [queued('two')] },
      turn: false,
      expected: '2 queued prompts would be dropped — ctrl+c hands them back to the bar, then /reload',
    },
  ])('refuses a reload that would drop $name', async ({ inbox, turn, expected }) => {
    const given = fixture()
    await given.lifecycle.openAgent(SESSION_A, false)
    given.setLive({})
    given.setInbox(inbox)
    if (turn) given.lifecycle.observe({ id: SESSION_A }, { type: 'turn/start' })
    given.trace.length = 0

    given.lifecycle.runReloadCommand()
    await flush()

    // The interrupt key already owns the decision to drop work, so a reload
    // asks for that key rather than stopping the turn itself.
    expect(given.notices.at(-1)).toBe(expected)
    expect(given.trace).toEqual([])
  })

  it('reloads the session this terminal drives without leaving the conversation', async () => {
    const given = fixture()
    await given.lifecycle.openAgent(SESSION_A, false)
    given.trace.length = 0

    given.lifecycle.runReloadCommand()
    await flush()

    // Reopening the same session is the switch a reader was already able to
    // make, so the preset generation is composed again and the log is replayed
    // into the screen the outgoing agent only now lets go of.
    expect(given.trace).toEqual([
      `presetFor:${SESSION_A}:true:false`,
      'installModelChoice',
      `mountPreset:${PRESET}`,
      'clearPresentScope',
      'resetTranscript',
      'resetRoster',
      `setViewed:${SESSION_A}`,
      'refreshJobs',
      `stagedSessionOpened:${SESSION_A}`,
      'promptMemorySessionOpened',
      'driver:idle',
      `session:${SESSION_START_REASONS.resume}:${SESSION_A}:${process.cwd()}`,
      'setPresentScope',
      `replay:${SESSION_A}`,
      'installCompletion',
    ])
    expect(given.lifecycle.activeSession()).toBe(SESSION_A)
    expect(given.notices.at(-1)).toBe("reloaded this session's composition; the transcript was replayed")
  })

  it('reports a composition that will not mount, and leaves the command usable again', async () => {
    const given = fixture()
    await given.lifecycle.openAgent(SESSION_A, false)
    given.refusePreset(new Error('the composition file has a syntax error'))

    given.lifecycle.runReloadCommand()
    await flush()

    expect(given.notices.at(-1)).toBe(
      'could not reload: the composition file has a syntax error — fix the composition and /reload again',
    )
    // The failed reload kept the outgoing agent driving, so the retry re-enters
    // a surface that never stopped answering the keyboard.
    expect(given.lifecycle.drivingAgent()).toBeDefined()
    given.refusePreset(undefined)
    given.lifecycle.runReloadCommand()
    await flush()
    expect(given.notices.at(-1)).toBe("reloaded this session's composition; the transcript was replayed")
  })

  it.each([
    {
      name: 'the agent is still starting',
      log: [{ type: 'turn/end' }] as readonly ForkEvent[],
      opened: false,
      expected: 'the agent is still starting; try again in a moment',
    },
    {
      name: 'no turn has completed',
      log: [{ type: 'user/message', seq: 1 }] as readonly ForkEvent[],
      opened: true,
      expected: 'nothing to fork yet: this session has no completed turn',
    },
  ])('refuses to fork while $name', async ({ log, opened, expected }) => {
    const given = fixture()
    if (opened) await given.lifecycle.openAgent(SESSION_A, false)
    given.setEvents(SESSION_A, log)
    const started = given.created.length
    given.trace.length = 0

    given.lifecycle.runForkCommand('')
    await flush()

    // A branch of an open exchange would hand a model half a conversation,
    // and a fork of nothing is not a session at all.
    expect(given.notices.at(-1)).toBe(expected)
    expect(given.created.length).toBe(started)
    expect(given.lifecycle.activeSession()).toBe(SESSION_A)
  })

  it('branches the conversation at its last completed turn and says where the cut was', async () => {
    const given = fixture()
    await given.lifecycle.openAgent(SESSION_A, false)
    const log: readonly ForkEvent[] = [
      { type: 'user/message', seq: 1 },
      { type: 'turn/end', seq: 2 },
      { type: 'turn/start', seq: 3 },
      { type: 'user/message', seq: 4 },
    ]
    const point = forkPoint(log)
    if (point === undefined) throw new Error('the fixture log has no completed turn to cut at')
    given.setEvents(SESSION_A, log)

    given.setRenames({ rename: (_session, title) => ({ title }) })
    given.lifecycle.runForkCommand('branch of it')
    await flush()

    const child = given.lifecycle.activeSession()
    expect(child).not.toBe(SESSION_A)
    expect(String(child).startsWith(NEW_SESSION_PREFIX)).toBe(true)
    expect(given.created[1]).toMatchObject({
      sessionId: child,
      seed: log.slice(0, point.inheritedEvents),
      meta: { parentSession: SESSION_A, isSeeded: true },
    })
    // The reader is told how much of their conversation the branch carries and
    // which boundary it was cut at, because the rest is only in the parent.
    expect(given.notices.slice(-2)).toEqual([
      'session renamed to "branch of it"',
      `forked from ${SESSION_A} at event ${point.boundarySeq} — ${point.inheritedEvents} inherited`,
    ])
  })

  it('reports a fork the host refused instead of leaving the branch half open', async () => {
    const given = fixture()
    await given.lifecycle.openAgent(SESSION_A, false)
    given.setEvents(SESSION_A, [{ type: 'turn/end', seq: 1 }])
    given.refusePreset(new Error('the parent preset cannot be mounted'))

    given.lifecycle.runForkCommand('')
    await flush()

    expect(given.notices.at(-1)).toBe('could not fork: the parent preset cannot be mounted')
    expect(given.lifecycle.activeSession()).toBe(SESSION_A)
  })

  it('refuses to rename a session with no title to set', () => {
    const given = fixture()

    given.lifecycle.runRenameCommand('')

    // The title is what the resume picker shows, so an empty one is a mistake
    // worth naming rather than a rename the picker cannot show.
    expect(given.notices).toEqual(['use /rename <title>; the title is what the resume picker shows'])
    expect(given.renders()).toBe(1)
  })

  it('refuses to rename when this profile has no title service', () => {
    const given = fixture()
    given.setRenames(undefined)

    given.lifecycle.runRenameCommand('mine')

    expect(given.notices).toEqual(['this profile has no session-title service, so this session cannot be renamed'])
  })

  it.each([
    { name: 'shortened it', rename: () => ({ title: 'a shorter title' }), expected: 'session renamed to "a shorter title"' },
    { name: 'kept it', rename: () => ({}), expected: 'session renamed to "mine"' },
    {
      name: 'refused it',
      rename: () => {
        throw new Error('title is empty')
      },
      expected: 'could not rename: title is empty',
    },
  ])('reports the title the harness $name rather than the one that was typed', ({ rename, expected }) => {
    const given = fixture()
    given.setRenames({ rename })

    given.lifecycle.runRenameCommand('mine')

    // The accepted title is what every other surface shows, so a reader who
    // set one is told the name the picker will actually carry.
    expect(given.notices.at(-1)).toBe(expected)
    expect(given.renders()).toBe(1)
  })

  it('follows the turn of the driven session and ignores another session', () => {
    const given = fixture()

    given.lifecycle.observe({ id: SESSION_B }, { type: 'turn/start' })
    expect(given.lifecycle.turnRunning()).toBe(false)
    expect(given.written).toEqual([])

    // Activity, the title, the bell and the job board belong to the agent this
    // terminal drives even while a child's conversation is on screen.
    given.lifecycle.observe({ id: SESSION_A }, { type: 'turn/start' })
    expect(given.lifecycle.turnRunning()).toBe(true)
    expect(typeof given.lifecycle.activity().startedAt).toBe('number')
    expect(given.written).toEqual([windowTitle(process.cwd(), 'working')])

    given.lifecycle.observe({ id: SESSION_A }, { type: 'turn/end' })
    expect(given.lifecycle.turnRunning()).toBe(false)
    expect(given.lifecycle.activity()).toEqual({ running: false, startedAt: undefined })
    expect(given.trace).toContain('turnSettled')
    expect(given.written.at(-1)).toBe(windowTitle(process.cwd(), 'ready'))
    // A job the turn started may have settled while the reader watched
    // elsewhere, and nothing else refreshes a live board.
    expect(given.trace).toContain('refreshJobs')
  })

  it.each([
    { name: 'a turn that ran long', bell: true, exiting: false, ranFor: BELL_DOCUMENTED_THRESHOLD_MS, rings: true },
    { name: 'a turn that ran too short', bell: true, exiting: false, ranFor: BELL_DOCUMENTED_THRESHOLD_MS - 1, rings: false },
    { name: 'a turn with the bell turned off', bell: false, exiting: false, ranFor: BELL_DOCUMENTED_THRESHOLD_MS, rings: false },
    { name: 'a turn that ended on the way out', bell: true, exiting: true, ranFor: BELL_DOCUMENTED_THRESHOLD_MS, rings: false },
  ])('rings for $name', ({ bell, exiting, ranFor, rings }) => {
    const given = fixture()
    given.setBell(bell)
    given.setExiting(exiting)
    const clock = vi.spyOn(Date, 'now')
    try {
      clock.mockReturnValue(1_000)
      given.lifecycle.observe({ id: SESSION_A }, { type: 'turn/start' })
      clock.mockReturnValue(1_000 + ranFor)
      given.lifecycle.observe({ id: SESSION_A }, { type: 'turn/end' })
      // The bell is a courtesy for the turn the reader walked away from, and
      // noise on the way out of the alternate screen.
      const titles = [windowTitle(process.cwd(), 'working'), windowTitle(process.cwd(), 'ready')]
      expect(given.written).toEqual(rings ? [...titles, BELL] : titles)
    } finally {
      clock.mockRestore()
    }
  })

  it('accepts the parent catalog and repaints for a queue that changed', () => {
    const given = fixture()
    const info = { agentId: SESSION_A, name: 'researcher' }

    given.lifecycle.observe({ id: SESSION_A }, { type: 'subagent/catalog', data: info })
    expect(given.catalog).toEqual([info])
    expect(given.renders()).toBe(1)

    given.lifecycle.observe({ id: SESSION_A }, { type: 'agent/inbox/spliced' })
    // A claim or a discard changes what is queued, and that belongs to this
    // session even while the transcript shows a child's conversation.
    expect(given.renders()).toBe(2)
  })

  it('reads the queued prompts from the inbox of the session it drives', () => {
    const given = fixture()
    given.setInbox({
      'next-step': [queued('a context a tool injected', 'plugin')],
      'next-turn': [queued('first'), queued('second')],
    })

    expect(given.lifecycle.queuedPrompts()).toEqual([])

    given.setLive({})
    // The queue sits on the editor that submits to the driven agent, and the
    // list is what an interrupt would hand back to the bar.
    expect(given.lifecycle.queuedPrompts()).toEqual(['first', 'second'])
  })

  it('reports the driver of the session it drives at the moment it is delivered', async () => {
    const given = fixture()
    for (const register of given.lifecycle.driverListeners()) expect(typeof register).toBe('function')

    given.delivery('agent/status', { agent: { id: SESSION_A }, status: 'running' })
    expect(given.trace).toContain('driver:running')

    given.trace.length = 0
    // Subagents share this process and dispatch their own status, so their
    // transitions must not move this pane's row.
    given.delivery('agent/status', { agent: { id: SESSION_B }, status: 'running' })
    given.delivery('agent/status', { agent: { id: SESSION_A }, status: 'restarting' })
    expect(given.trace).toEqual([])

    await given.lifecycle.openAgent(SESSION_B, false)
    given.trace.length = 0
    // The reader can switch between two transitions, so the row follows the
    // session this terminal now drives rather than the one it left.
    given.delivery('agent/status', { agent: { id: SESSION_A }, status: 'idle' })
    expect(given.trace).toEqual([])
    given.delivery('agent/status', { agent: { id: SESSION_B }, status: 'idle' })
    expect(given.trace).toEqual(['driver:idle'])
  })

  it('repaints on the status clock only while a turn is open, and only until it is stopped', () => {
    vi.useFakeTimers()
    try {
      const given = fixture()

      vi.advanceTimersByTime(STATUS_TICK_MS)
      expect(given.renders()).toBe(0)

      given.lifecycle.observe({ id: SESSION_A }, { type: 'turn/start' })
      vi.advanceTimersByTime(STATUS_TICK_MS)
      // Only a running turn has anything to say over time, so the clock is what
      // keeps the reader's elapsed time moving without them pressing a key.
      expect(given.renders()).toBe(1)

      given.lifecycle.stopClock()
      vi.advanceTimersByTime(STATUS_TICK_MS)
      expect(given.renders()).toBe(1)
      given.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

