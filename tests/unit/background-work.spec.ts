/**
 * The row that keeps working programs visible: the job board a refresh reads,
 * the two commands that show it, and the child-agent lifecycle that arrives as
 * a service event rather than as part of a transcript.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TuiAgent } from '@/agent/host.ts'
import { JOB_READ_LINES } from '@/jobs.ts'
import { createBackgroundWork, type BackgroundWork } from '@/surface/background-work.ts'

/** Fixed clock, so every duration a row prints is a number this case can name. */
const NOW = Date.UTC(2024, 5, 1)

const SESSION = 'tui-session-1' as SessionId
const OTHER_SESSION = 'tui-session-2' as SessionId
const AGENT = { id: 'agent-1' }
const TUI_AGENT = { agent: AGENT } as unknown as TuiAgent

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

const job = (id: string, overrides: Record<string, unknown> = {}): unknown => ({
  id,
  kind: 'build',
  label: `${id} task`,
  status: 'running',
  startedAt: NOW,
  ...overrides,
})

interface RegistryOptions {
  readonly jobs?: readonly unknown[]
  readonly read?: unknown
  readonly kill?: unknown
  /** A registry that cannot report its own changes, which is a real composition. */
  readonly silent?: boolean
  /** What a listing throws, for a registry that cannot be asked at all. */
  readonly listError?: unknown
}

interface FixtureOptions {
  readonly registry?: RegistryOptions
  /** The composition mounts no registry at all. */
  readonly noRegistry?: boolean
  readonly agents?: unknown
  /** The surface has composed, but no agent is driving it yet. */
  readonly noAgent?: boolean
  readonly active?: SessionId
}

type Fixture = ReturnType<typeof fixture>

function fixture(options: FixtureOptions = {}) {
  const notices: string[] = []
  const markers: string[] = []
  const navigated: string[] = []
  const listCalls: unknown[] = []
  const readCalls: { readonly id: string; readonly caller: unknown }[] = []
  const killCalls: { readonly id: string; readonly caller: unknown; readonly reason: string }[] = []
  const watchers: ((owner?: unknown) => void)[] = []
  const registered: string[] = []
  const handlers = new Map<string, (...args: readonly unknown[]) => void>()
  let renders = 0
  let agent: TuiAgent | undefined = options.noAgent === true ? undefined : TUI_AGENT
  const active = options.active ?? SESSION
  const registryOptions = options.registry

  const registry = options.noRegistry === true || registryOptions === undefined
    ? undefined
    : {
        list: (caller?: unknown) => {
          listCalls.push(caller)
          if (registryOptions.listError !== undefined) throw registryOptions.listError
          return registryOptions.jobs ?? []
        },
        read: (id: string, caller?: unknown) => {
          readCalls.push({ id, caller })
          return registryOptions.read
        },
        kill: (id: string, caller?: unknown, reason?: string) => {
          killCalls.push({ id, caller, reason: reason ?? '' })
          return registryOptions.kill
        },
        ...(registryOptions.silent === true ? {} : {
          onJobsChanged: (listener: (owner?: unknown) => void) => {
            watchers.push(listener)
            return () => {
              const at = watchers.indexOf(listener)
              if (at >= 0) watchers.splice(at, 1)
            }
          },
        }),
      }

  const ctx = {
    get: (name: string) => name === 'jobs' ? registry : name === 'agents' ? options.agents : undefined,
    on: (event: string, handler: (...args: readonly unknown[]) => void) => {
      registered.push(event)
      handlers.set(event, handler)
      return () => {
        handlers.delete(event)
      }
    },
  } as unknown as Context

  const work = createBackgroundWork(ctx, {
    drivingAgent: () => agent,
    activeSession: () => active,
    backgroundChanged: () => {},
    notice: text => {
      notices.push(text)
    },
    marker: text => {
      markers.push(text)
    },
    render: () => {
      renders += 1
    },
    navigate: id => {
      navigated.push(id)
    },
  })

  /** Register the listeners the way the composition root does, and keep their teardowns. */
  const listen = (): readonly (() => void)[] => work.subagentListeners()
  return {
    work,
    notices,
    markers,
    navigated,
    listCalls,
    readCalls,
    killCalls,
    watchers,
    registered,
    listen,
    renderCount: () => renders,
    fire: (event: string, info: unknown) => {
      const handler = handlers.get(event)
      if (handler === undefined) throw new Error(`the ${event} listener was never registered`)
      handler(info)
    },
    /** Start a later step from a clean slate, so its own calls are the only signal. */
    reset: () => {
      notices.length = 0
      markers.length = 0
      navigated.length = 0
      listCalls.length = 0
      readCalls.length = 0
      killCalls.length = 0
      renders = 0
    },
  }
}

describe('the job board', () => {
  it('says a profile without a job registry cannot list', () => {
    const given = fixture({ noRegistry: true })

    // Jobs are live process state, so a composition without a registry can run
    // but cannot show a board; naming that is better than an empty list the
    // reader would read as "nothing is running".
    given.work.runJobsCommand('')

    expect(given.notices).toEqual(['this profile has no job registry, so there is nothing to list'])
    expect(given.renderCount()).toBe(1)
  })

  it('says the agent is still starting rather than listing nothing', () => {
    const given = fixture({ registry: { jobs: [job('j1')] }, noAgent: true })

    given.work.runJobsCommand('')

    expect(given.notices).toEqual(['the agent is still starting; try again in a moment'])
    expect(given.listCalls).toEqual([])
  })

  it('lists the board newest first, in units the reader counts', () => {
    const given = fixture({
      registry: {
        jobs: [
          job('j1', { kind: 'build', label: 'build the docs', startedAt: NOW - 5_000 }),
          job('j2', { kind: 'test', label: '', status: 'completed', startedAt: NOW - 120_000, finishedAt: NOW - 60_000 }),
        ],
      },
    })

    given.work.runJobsCommand('')

    expect(given.notices).toEqual([
      'jobs · 2 (1 running)\n  j1 · running 5s — build the docs\n  j2 · completed 1m ago — test',
    ])
    // The caller identity is what the registry scopes its board by: a session
    // that listed another agent's jobs would show work it never started.
    expect(given.listCalls).toEqual([AGENT])
    expect(given.work.jobs()).toEqual([
      { id: 'j1', kind: 'build', label: 'build the docs', status: 'running', startedAt: NOW - 5_000, finishedAt: undefined },
      { id: 'j2', kind: 'test', label: '', status: 'completed', startedAt: NOW - 120_000, finishedAt: NOW - 60_000 },
    ])
  })

  it('reports a registry that cannot be listed instead of dying', () => {
    const given = fixture({ registry: { listError: new Error('registry is gone') } })

    expect(() => given.work.runJobsCommand('')).not.toThrow()

    // The command answers with the reason and keeps its shape: the reader is
    // told why nothing was listed rather than the surface going silent.
    expect(given.notices).toEqual(['could not list background jobs: registry is gone', 'no background jobs'])
    expect(given.work.jobs()).toEqual([])
    expect(given.renderCount()).toBe(2)
  })

  it('says there are no background jobs rather than an empty board', () => {
    const given = fixture({ registry: { jobs: [] } })

    given.work.runJobsCommand('')

    expect(given.notices).toEqual(['no background jobs'])
  })

  it('shows the tail of a chatty job, so one job cannot flood the view', () => {
    const lines = Array.from({ length: JOB_READ_LINES + 5 }, (_value, index) => `line ${index + 1}`)
    const given = fixture({ registry: { jobs: [], read: { text: lines.join('\n') } } })

    given.work.runJobsCommand('read j1')

    expect(given.notices).toEqual([`j1 output\n${lines.slice(-JOB_READ_LINES).join('\n')}`])
    expect(given.readCalls).toEqual([{ id: 'j1', caller: AGENT }])
  })

  it.each([
    { read: undefined, shape: 'no record' },
    { read: { text: '   \n  ' }, shape: 'whitespace only' },
  ])('says a job has no output yet when the read carries none ($shape)', ({ read }) => {
    const given = fixture({ registry: { jobs: [], read } })

    given.work.runJobsCommand('read j1')

    expect(given.notices).toEqual(['j1: no output yet'])
  })

  it.each([
    { kill: 'requested', said: 'j1: stop requested' },
    { kill: 'already-finished', said: 'j1 had already finished' },
    { kill: undefined, said: 'j1: no such job' },
  ])('answers the kill with what the registry did ($said)', ({ kill, said }) => {
    const given = fixture({ registry: { jobs: [], kill } })

    given.work.runJobsCommand('kill j1')

    expect(given.notices).toEqual([said])
    // The reason travels with the kill so the registry records why a program
    // the reader cannot see was stopped.
    expect(given.killCalls).toEqual([{ id: 'j1', caller: AGENT, reason: 'killed from the terminal' }])
  })

  it.each([
    { argument: 'bogus', said: '/jobs: unknown action "bogus" — use /jobs, /jobs read <id>, or /jobs kill <id>' },
    { argument: 'read', said: '/jobs: read needs a job id; /jobs lists them' },
  ])('refuses what it cannot act on ($argument)', ({ argument, said }) => {
    const given = fixture({ registry: { jobs: [] } })

    given.work.runJobsCommand(argument)

    expect(given.notices).toEqual([said])
  })

  it('reads the board as empty when there is no agent to scope it by', () => {
    const given = fixture({ registry: { jobs: [job('j1')] }, noAgent: true })

    given.work.refresh()

    expect(given.work.jobs()).toEqual([])
    expect(given.renderCount()).toBe(1)
  })

  it('reads the board as empty when the composition mounts no registry', () => {
    const given = fixture({ noRegistry: true })

    given.work.refresh()

    expect(given.work.jobs()).toEqual([])
    expect(given.renderCount()).toBe(1)
  })
})

describe('child agents', () => {
  it('registers one listener per lifecycle event and hands back their teardown', () => {
    const given = fixture()

    const disposers = given.listen()

    // They come back rather than being pushed somewhere: the composition root
    // keeps one ordered list of teardowns and unwinds it in reverse.
    expect(given.registered).toEqual(['subagent/start', 'subagent/end'])
    expect(disposers).toHaveLength(2)
    for (const dispose of disposers) dispose()
    expect(() => given.fire('subagent/start', {})).toThrow('the subagent/start listener was never registered')
  })

  it.each([
    {
      event: 'subagent/start',
      info: { runId: 'r1', id: 'child-1', provider: 'claude' },
      said: 'subagent claude started · child-1',
    },
    {
      event: 'subagent/start',
      info: { runId: 'r2', id: 'child-2' },
      said: 'subagent subagent started · child-2',
    },
    { event: 'subagent/start', info: 42, said: 'subagent subagent started' },
    { event: 'subagent/end', info: { runId: 'r1', provider: 'claude' }, said: 'subagent claude finished' },
    {
      event: 'subagent/end',
      info: { runId: 'r1', id: 'child-1', provider: 'claude', stopReason: 'failed' },
      said: 'subagent claude finished · failed',
    },
    { event: 'subagent/end', info: null, said: 'subagent subagent finished' },
  ])('decorates the transcript with "$said"', ({ event, info, said }) => {
    const given = fixture()
    given.listen()

    given.fire(event, info)

    // Lifecycle is a service event rather than a session event, so the reader
    // only learns it happened from the marker this leaves.
    expect(given.markers).toEqual([said])
    expect(given.renderCount()).toBe(1)
  })

  it('lists the children this session started, named by the parent catalog', () => {
    const given = fixture()
    given.listen()
    given.work.acceptCatalog({ childId: 'child-1', label: 'summarize the parser' })
    given.fire('subagent/start', { runId: 'r1', id: 'child-1', provider: 'claude' })
    given.reset()

    given.work.runSubagentsCommand('')

    expect(given.notices).toEqual([
      'subagents · 1 (1 running)\n  child-1 · summarize the parser · claude · running 1s',
    ])
  })

  it('says no child has run rather than an empty list', () => {
    const given = fixture()

    given.work.runSubagentsCommand('')

    expect(given.notices).toEqual(['no subagents have run in this session'])
  })

  it('forgets every child on a reset, so a new session starts clean', () => {
    const given = fixture()
    given.listen()
    given.fire('subagent/start', { runId: 'r1', id: 'child-1', provider: 'claude' })

    given.work.resetRoster()
    given.reset()
    given.work.runSubagentsCommand('')

    expect(given.notices).toEqual(['no subagents have run in this session'])
  })

  it.each([
    { argument: 'open child-1', expected: 'child-1', why: 'the id the reader can see' },
    { argument: 'open last', expected: 'child-2', why: 'the newest run, for a reader who just watched it start' },
  ])('shows $why with $argument', ({ argument, expected }) => {
    const given = fixture()
    given.listen()
    given.fire('subagent/start', { runId: 'r1', id: 'child-1', provider: 'claude' })
    vi.setSystemTime(NOW + 1_000)
    given.fire('subagent/start', { runId: 'r2', id: 'child-2', provider: 'claude' })
    given.reset()

    given.work.runSubagentsCommand(argument)

    expect(given.navigated).toEqual([expected])
    // Showing a child moves the reader there; a notice would be a second answer
    // to the same request.
    expect(given.notices).toEqual([])
  })

  it('shows the one child a unique prefix names', () => {
    const given = fixture()
    given.listen()
    given.fire('subagent/start', { runId: 'r1', id: 'child-1', provider: 'claude' })
    given.reset()

    given.work.runSubagentsCommand('open child')

    expect(given.navigated).toEqual(['child-1'])
  })

  it.each([
    { argument: 'open child', said: 'child: no single child matches; /subagents lists them' },
    { argument: 'open nope', said: 'nope: no single child matches; /subagents lists them' },
  ])('refuses a name that does not resolve to one child ($argument)', ({ argument, said }) => {
    const given = fixture()
    given.listen()
    given.fire('subagent/start', { runId: 'r1', id: 'child-1', provider: 'claude' })
    given.fire('subagent/start', { runId: 'r2', id: 'child-2', provider: 'claude' })
    given.reset()

    given.work.runSubagentsCommand(argument)

    // An ambiguous prefix must resolve to nothing rather than to the wrong
    // child: the reader would otherwise be shown a session they did not name.
    expect(given.notices).toEqual([said])
    expect(given.navigated).toEqual([])
  })

  it('stops a live child the way the parent interrupt does', () => {
    const cancel = vi.fn()
    const given = fixture({ agents: { get: (id: string) => id === 'child-1' ? { cancel } : undefined } })

    given.work.runSubagentsCommand('kill child-1')

    expect(cancel).toHaveBeenCalledWith({ kind: 'user' })
    expect(given.notices).toEqual(['child-1: stop requested'])
  })

  it.each([
    { shape: 'the child is not one of ours', options: { agents: { get: () => undefined } } },
    { shape: 'the composition mounts no agent registry', options: {} },
  ])('says there is no live child to stop when $shape', ({ options }) => {
    const given = fixture(options)

    given.work.runSubagentsCommand('kill child-1')

    expect(given.notices).toEqual(['child-1: no live child with that id'])
  })

  it.each([
    { argument: 'bogus', said: '/subagents: unknown action "bogus" — use /subagents, /subagents open <id>, or /subagents kill <id>' },
    { argument: 'kill', said: '/subagents: kill needs a child id; /subagents lists them' },
  ])('refuses what it cannot act on ($argument)', ({ argument, said }) => {
    const given = fixture()

    given.work.runSubagentsCommand(argument)

    expect(given.notices).toEqual([said])
  })
})

describe('watching the board', () => {
  it('refreshes for this session and ignores a board another session owns', () => {
    const given = fixture({ registry: { jobs: [job('j1')] } })

    const dispose = given.work.watchJobs()
    expect(given.watchers).toHaveLength(1)

    given.reset()
    given.watchers[0]?.({ id: OTHER_SESSION })
    // A job board is process-wide, so a change another terminal's board owns
    // must not repaint this one's dock.
    expect(given.listCalls).toEqual([])
    expect(given.renderCount()).toBe(0)

    given.watchers[0]?.({ id: SESSION })
    expect(given.listCalls).toEqual([AGENT])
    expect(given.renderCount()).toBe(1)

    given.watchers[0]?.(undefined)
    expect(given.listCalls).toHaveLength(2)

    dispose()
    expect(given.watchers).toEqual([])
  })

  it('keeps the watch alive when a refresh cannot list the board', () => {
    const given = fixture({ registry: { listError: new Error('registry is gone') } })
    const dispose = given.work.watchJobs()

    // The watcher runs with no reader waiting on it, so a registry failure it
    // meets has to stay a notice rather than escape into the host loop.
    expect(() => given.watchers[0]?.({ id: SESSION })).not.toThrow()
    expect(given.notices).toEqual(['could not list background jobs: registry is gone'])
    expect(given.work.jobs()).toEqual([])
    expect(given.renderCount()).toBe(1)

    dispose()
  })

  it.each([
    { shape: 'no registry is mounted', options: { noRegistry: true } },
    { shape: 'the registry cannot report changes', options: { registry: { silent: true } } },
  ])('hands back a teardown that does nothing when $shape', ({ options }) => {
    const given = fixture(options)

    // The composition root always pushes a disposer, so the absent watch has to
    // answer one rather than leaving the list of teardowns to branch.
    expect(() => given.work.watchJobs()()).not.toThrow()
    expect(given.watchers).toEqual([])
  })
})
