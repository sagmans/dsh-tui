import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HERDR_AGENT, HERDR_SOURCE, SESSION_START_REASONS } from '@/herdr/constants.ts'
import { createHerdrReporter, releaseAgentSync } from '@/herdr/reporter.ts'
import type { HerdrClient, HerdrEnvironment } from '@/herdr/client.ts'
import type { StateReport } from '@/herdr/client.ts'

interface Recorded {
  readonly kind: 'state' | 'session' | 'metadata'
  readonly value: unknown
}

/** A client that records instead of dialling: these tests are about decisions. */
function recordingClient(): {
  readonly calls: Recorded[]
  readonly client: HerdrClient
  readonly transport: string[]
} {
  const calls: Recorded[] = []
  const transport: string[] = []
  return {
    calls,
    transport,
    client: {
      enabled: true,
      reportState: async (report: StateReport) => (calls.push({ kind: 'state', value: report }), true),
      reportSession: async report => (calls.push({ kind: 'session', value: report }), true),
      reportMetadata: async tokens => (calls.push({ kind: 'metadata', value: tokens }), true),
      stop: () => {
        transport.push('stop')
      },
      settle: async () => {
        transport.push('settle')
      },
    },
  }
}

const states = (calls: readonly Recorded[]): unknown[] => calls.filter(call => call.kind === 'state').map(call => call.value)

let temporary: string | undefined

afterEach(() => {
  if (temporary !== undefined) rmSync(temporary, { force: true, recursive: true })
  temporary = undefined
})

/** A stand-in `herdr` binary that records the argv it was called with. */
function fakeHerdrBinary(): { readonly bin: string; readonly sink: string; readonly argv: () => string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-release-'))
  temporary = dir
  const sink = join(dir, 'argv.log')
  const bin = join(dir, 'herdr')
  writeFileSync(bin, '#!/bin/sh\nprintf \'%s\\n\' "$@" >> "$ARGV_SINK"\n', 'utf8')
  chmodSync(bin, 0o755)
  return {
    bin,
    sink,
    argv: () => (existsSync(sink) ? readFileSync(sink, 'utf8').split('\n').filter(line => line !== '') : []),
  }
}

describe('createHerdrReporter', () => {
  it('claims the pane as idle the first time it publishes', () => {
    const { calls, client } = recordingClient()
    const reporter = createHerdrReporter({ client, now: () => 1 })

    reporter.publish()

    expect(states(calls)).toEqual([{ state: 'idle', message: undefined, seq: 1001, sessionId: undefined }])
  })

  it('does not repeat a state Herdr is already showing', () => {
    const { calls, client } = recordingClient()
    const reporter = createHerdrReporter({ client, now: () => 1 })

    reporter.publish()
    reporter.publish()
    reporter.driver('idle')

    expect(states(calls).length).toBe(1)
  })

  it('is working while the driver runs and idle when it stops', () => {
    const { calls, client } = recordingClient()
    const reporter = createHerdrReporter({ client, now: () => 1 })

    reporter.driver('running')
    reporter.driver('idle')

    expect(states(calls).map(state => (state as StateReport).state)).toEqual(['working', 'idle'])
  })

  it('keeps one working report across the turns a driver chains', () => {
    const { calls, client } = recordingClient()
    const reporter = createHerdrReporter({ client, now: () => 1 })

    reporter.driver('running')
    reporter.driver('running')

    // A chained turn is not a driver transition — nothing at all arrives here
    // between two turns of one run — and a repeated running status is no
    // change, so the pane never reads as done mid-run.
    expect(states(calls).map(state => (state as StateReport).state)).toEqual(['working'])
  })

  it('outranks a running driver with a wait, and returns to it', () => {
    const { calls, client } = recordingClient()
    const reporter = createHerdrReporter({ client, now: () => 1 })

    reporter.driver('running')
    reporter.block('approval needed · Bash')
    reporter.unblock()

    expect(states(calls)).toEqual([
      { state: 'working', message: undefined, seq: 1001, sessionId: undefined },
      { state: 'blocked', message: 'approval needed · Bash', seq: 1002, sessionId: undefined },
      { state: 'working', message: undefined, seq: 1003, sessionId: undefined },
    ])
  })

  it('counts stacked waits and keeps the newest one named', () => {
    const { calls, client } = recordingClient()
    const reporter = createHerdrReporter({ client, now: () => 1 })

    reporter.block('approval needed · Bash')
    reporter.block('question · continue?')
    reporter.unblock()

    const last = states(calls).at(-1) as StateReport
    expect(last.state).toBe('blocked')
    expect(last.message).toBe('question · continue?')

    reporter.unblock()
    expect((states(calls).at(-1) as StateReport).state).toBe('idle')
  })

  it('returns to idle after a wait settles only when the driver has stopped', () => {
    const { calls, client } = recordingClient()
    const reporter = createHerdrReporter({ client, now: () => 1 })

    reporter.driver('idle')
    reporter.block('approval needed · Bash')
    reporter.unblock()

    expect((states(calls).at(-1) as StateReport).state).toBe('idle')
  })

  it('never counts below a settled wait', () => {
    const { calls, client } = recordingClient()
    const reporter = createHerdrReporter({ client, now: () => 1 })

    reporter.unblock()
    reporter.block('approval needed · Bash')

    expect((states(calls).at(-1) as StateReport).state).toBe('blocked')
  })

  it('reports the session identity, the reason, and the tokens that carry it', () => {
    const { calls, client } = recordingClient()
    const reporter = createHerdrReporter({ client, now: () => 1 })

    reporter.session({ id: 'tui-session-9', cwd: '/tmp/project', reason: SESSION_START_REASONS.fork })

    expect(calls.find(call => call.kind === 'session')?.value).toEqual({
      sessionId: 'tui-session-9',
      seq: 1001,
      reason: 'fork',
    })
    expect(calls.find(call => call.kind === 'metadata')?.value).toEqual({ dsh_session: 'tui-session-9', dsh_cwd: '/tmp/project' })
  })

  it('resends the state on a session change even when it did not change', () => {
    const { calls, client } = recordingClient()
    const reporter = createHerdrReporter({ client, now: () => 1 })

    reporter.publish()
    reporter.session({ id: 'tui-session-9', cwd: '/tmp/project', reason: SESSION_START_REASONS.resume })

    const reported = states(calls)
    expect(reported.length).toBe(2)
    expect((reported[1] as StateReport).sessionId).toBe('tui-session-9')
  })

  it('hands the pane back only once', () => {
    let released = 0
    const { client } = recordingClient()
    const reporter = createHerdrReporter({ client, releaseSync: () => {
      released += 1
    } })

    reporter.releaseSync()
    reporter.releaseSync()

    expect(released).toBe(1)
  })

  it('retries a report Herdr did not acknowledge without another lifecycle call', async () => {
    let reachable = false
    const calls: Recorded[] = []
    const client: HerdrClient = {
      enabled: true,
      reportState: async report => (calls.push({ kind: 'state', value: report }), reachable),
      reportSession: async () => true,
      reportMetadata: async () => true,
      stop: () => {},
      settle: async () => {},
    }
    const reporter = createHerdrReporter({ client, now: () => 1, retryBaseMs: 1 })

    reporter.driver('idle')
    await Promise.resolve()
    expect(states(calls).length).toBe(1)

    // Nothing else happens in this pane, so a retry that waited for another
    // event would never come: the reporter has to make it happen.
    reachable = true
    await new Promise(resolve => setTimeout(resolve, 40))

    expect(states(calls).length).toBe(2)
  })

  it('stops retrying once the row has been handed back', async () => {
    const calls: Recorded[] = []
    const client: HerdrClient = {
      enabled: true,
      reportState: async report => (calls.push({ kind: 'state', value: report }), false),
      reportSession: async () => true,
      reportMetadata: async () => true,
      stop: () => {},
      settle: async () => {},
    }
    const reporter = createHerdrReporter({ client, now: () => 1, retryBaseMs: 1, releaseSync: () => {} })

    reporter.driver('running')
    await Promise.resolve()
    await reporter.release()
    const seen = states(calls).length

    await new Promise(resolve => setTimeout(resolve, 40))

    // A retry after the release would claim the row back for a pane that is no
    // longer an agent.
    expect(states(calls).length).toBe(seen)
  })

  it('waits for the report on the wire before handing the row back', async () => {
    const order: string[] = []
    let complete: ((value: boolean) => void) | undefined
    let finishSettling: (() => void) | undefined
    const client: HerdrClient = {
      enabled: true,
      reportState: () => new Promise<boolean>(resolve => {
        complete = resolve
      }),
      reportSession: async () => true,
      reportMetadata: async () => true,
      stop: () => {
        if (!order.includes('stop')) order.push('stop')
      },
      settle: async () => new Promise<void>(resolve => {
        order.push('settle')
        finishSettling = resolve
      }),
    }
    let released = 0
    const reporter = createHerdrReporter({ client, now: () => 1, releaseSync: () => {
      order.push('release')
      released += 1
    } })

    reporter.driver('running')
    const handingBack = reporter.release()
    await Promise.resolve()

    // The report is still unanswered, and a release that outran it would be
    // ignored for a pane nothing has claimed: the late report would then claim
    // the row after teardown.
    expect(released).toBe(0)
    complete?.(true)
    finishSettling?.()
    await handingBack

    expect(order).toEqual(['stop', 'settle', 'release'])
  })

  it('retries a session identity a socket was down for', async () => {
    let reachable = false
    const calls: Recorded[] = []
    const client: HerdrClient = {
      enabled: true,
      reportState: async report => (calls.push({ kind: 'state', value: report }), true),
      reportSession: async report => (calls.push({ kind: 'session', value: report }), reachable),
      reportMetadata: async tokens => (calls.push({ kind: 'metadata', value: tokens }), reachable),
      stop: () => {},
      settle: async () => {},
    }
    const reporter = createHerdrReporter({ client, now: () => 1 })

    reporter.session({ id: 'tui-session-9', cwd: '/tmp/project', reason: SESSION_START_REASONS.resume })
    await Promise.resolve()
    expect(calls.filter(call => call.kind === 'session').length).toBe(1)

    reachable = true
    reporter.publish()
    await Promise.resolve()

    // The identity is how a reader returns to this conversation and its tokens
    // outlive the pane, so both stay owed until Herdr confirms them.
    expect(calls.filter(call => call.kind === 'session').length).toBe(2)
    expect(calls.filter(call => call.kind === 'metadata').length).toBe(2)
  })

  it('reports nothing once the pane has been handed back', () => {
    let released = 0
    const { calls, client } = recordingClient()
    const reporter = createHerdrReporter({ client, releaseSync: () => {
      released += 1
    } })

    reporter.driver('running')
    reporter.releaseSync()
    reporter.driver('idle')
    reporter.block('approval needed · Bash')
    reporter.session({ id: 'tui-session-9', cwd: '/tmp/project', reason: SESSION_START_REASONS.resume })
    reporter.publish(true)

    // A report landing after the release would claim the row back for a process
    // that is on its way out.
    expect(released).toBe(1)
    expect(states(calls).length).toBe(1)
    expect(calls.filter(call => call.kind !== 'state')).toEqual([])
  })

  it('registers its exit release and gives the registration back', () => {
    const { client } = recordingClient()
    const reporter = createHerdrReporter({ client })
    const before = process.listenerCount('exit')

    const unregister = reporter.registerExitRelease()
    expect(process.listenerCount('exit')).toBe(before + 1)

    unregister()
    expect(process.listenerCount('exit')).toBe(before)
  })
})

describe('releaseAgentSync', () => {
  const paneEnv = (fake: { readonly bin: string; readonly sink: string }): HerdrEnvironment => ({
    HERDR_ENV: '1',
    HERDR_PANE_ID: 'w3:p1',
    HERDR_SOCKET_PATH: '/tmp/unused.sock',
    HERDR_BIN_PATH: fake.bin,
    ARGV_SINK: fake.sink,
  })

  it('releases through the Herdr CLI, naming pane, source, agent, and sequence', () => {
    const fake = fakeHerdrBinary()

    releaseAgentSync(paneEnv(fake), 4242)

    expect(fake.argv()).toEqual([
      'pane', 'release-agent', 'w3:p1', '--source', HERDR_SOURCE, '--agent', HERDR_AGENT, '--seq', '4242',
    ])
  })

  it('releases with a sequence that beats the reports it sent', () => {
    const fake = fakeHerdrBinary()
    const { calls, client } = recordingClient()
    const reporter = createHerdrReporter({ client, env: paneEnv(fake), now: () => 1 })

    reporter.driver('running')
    reporter.block('approval needed · Bash')
    reporter.releaseSync()

    const sent = states(calls).map(state => (state as StateReport).seq)
    const argv = fake.argv()
    expect(sent.length).toBe(2)
    expect(Number(argv[argv.indexOf('--seq') + 1])).toBeGreaterThan(Math.max(...sent))
  })

  it('does nothing away from Herdr', () => {
    const fake = fakeHerdrBinary()

    releaseAgentSync({ HERDR_PANE_ID: 'w3:p1', HERDR_BIN_PATH: fake.bin, ARGV_SINK: fake.sink }, 1)

    expect(fake.argv()).toEqual([])
  })

  it('does nothing without a pane to release', () => {
    const fake = fakeHerdrBinary()

    releaseAgentSync({ HERDR_ENV: '1', HERDR_SOCKET_PATH: '/tmp/unused.sock', HERDR_BIN_PATH: fake.bin, ARGV_SINK: fake.sink }, 1)

    expect(fake.argv()).toEqual([])
  })
})
