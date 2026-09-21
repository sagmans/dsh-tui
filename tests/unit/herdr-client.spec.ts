import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acceptedTokens, createHerdrClient, socketEndpoint } from '@/herdr/client.ts'
import { HERDR_AGENT, HERDR_SOURCE, MAX_METADATA_VALUE_CHARS, METADATA_TOKENS } from '@/herdr/constants.ts'
import type { HerdrEnvironment } from '@/herdr/client.ts'

const PANE_ID = 'w1:p2'

type Request = { id?: string; method?: string; params?: Record<string, unknown> }

interface FakeHerdr {
  readonly path: string
  readonly requests: readonly Request[]
  close(): Promise<void>
}

let temporary: string | undefined
let server: FakeHerdr | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
  if (temporary !== undefined) rmSync(temporary, { force: true, recursive: true })
  temporary = undefined
})

/**
 * A stand-in for the multiplexer's socket.
 *
 * The transport is tested against a real listener rather than a stubbed one:
 * framing, response matching, and the attempt budget are the parts that break in
 * production, and none of them survive being faked.
 */
/** An answer that means the server went away, which a caller may retry. */
const HANGUP = "hangup"
/** How long a hangup waits, so a test can stop the transport mid-attempt. */
const HANGUP_DELAY_MS = 30

async function listen(answer: (request: Request) => unknown): Promise<FakeHerdr> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-herdr-'))
  temporary = dir
  const path = join(dir, 'herdr.sock')
  const requests: Request[] = []
  const sockets: Socket[] = []
  const listener: Server = createServer(socket => {
    sockets.push(socket)
    socket.on('data', chunk => {
      const request = JSON.parse(chunk.toString('utf8')) as Request
      requests.push(request)
      const response = answer(request)
      if (response === HANGUP) {
        setTimeout(() => socket.destroy(), HANGUP_DELAY_MS)
        return
      }
      if (response !== undefined) socket.end(`${JSON.stringify(response)}\n`)
    })
  })
  await new Promise<void>(resolve => listener.listen(path, resolve))
  const fake: FakeHerdr = {
    path,
    requests,
    close: () => new Promise<void>(resolve => {
      for (const socket of sockets) socket.destroy()
      listener.close(() => resolve())
    }),
  }
  server = fake
  return fake
}

const env = (socketPath: string): HerdrEnvironment => ({
  HERDR_ENV: '1',
  HERDR_PANE_ID: PANE_ID,
  HERDR_SOCKET_PATH: socketPath,
})

const ok = (request: Request): unknown => ({ id: request.id, result: {} })

describe('createHerdrClient', () => {
  it('names the pane, the reporter, the agent, and the state', async () => {
    const herdr = await listen(ok)
    const client = createHerdrClient(env(herdr.path))

    expect(client.enabled).toBe(true)
    expect(await client.reportState({ state: 'working', message: undefined, seq: 7, sessionId: undefined })).toBe(true)

    const [request] = herdr.requests
    expect(request?.method).toBe('pane.report_agent')
    expect(request?.params).toEqual({ pane_id: PANE_ID, source: HERDR_SOURCE, agent: HERDR_AGENT, state: 'working', seq: 7 })
    expect(String(request?.id).startsWith(`${HERDR_SOURCE}:`)).toBe(true)
  })

  it('carries a wait\'s message and a known session id', async () => {
    const herdr = await listen(ok)
    const client = createHerdrClient(env(herdr.path))

    await client.reportState({ state: 'blocked', message: 'approval needed · Bash', seq: 8, sessionId: 'tui-session-1' })

    expect(herdr.requests[0]?.params).toMatchObject({ state: 'blocked', message: 'approval needed · Bash', agent_session_id: 'tui-session-1' })
  })

  it('answers a session start with the identity and the reason', async () => {
    const herdr = await listen(ok)
    const client = createHerdrClient(env(herdr.path))

    await client.reportSession({ sessionId: 'tui-session-2', seq: 9, reason: 'resume' })

    expect(herdr.requests[0]?.method).toBe('pane.report_agent_session')
    expect(herdr.requests[0]?.params).toEqual({
      pane_id: PANE_ID,
      source: HERDR_SOURCE,
      agent: HERDR_AGENT,
      agent_session_id: 'tui-session-2',
      seq: 9,
      session_start_source: 'resume',
    })
  })

  it('publishes tokens under its own source so nothing else can claim them', async () => {
    const herdr = await listen(ok)
    const client = createHerdrClient(env(herdr.path))

    await client.reportMetadata({ [METADATA_TOKENS.session]: 'tui-session-3', [METADATA_TOKENS.cwd]: '/tmp/project' })

    expect(herdr.requests[0]?.method).toBe('pane.report_metadata')
    expect(herdr.requests[0]?.params).toMatchObject({
      applies_to_source: HERDR_SOURCE,
      tokens: { dsh_session: 'tui-session-3', dsh_cwd: '/tmp/project' },
    })
  })

  it('is inert away from Herdr and never dials', async () => {
    const started = Date.now()
    const client = createHerdrClient({ HERDR_ENV: '1', HERDR_SOCKET_PATH: '/nonexistent.sock' }, { timeoutMs: 5000 })

    expect(client.enabled).toBe(false)
    expect(await client.reportState({ state: 'idle', message: undefined, seq: 1, sessionId: undefined })).toBe(true)
    expect(Date.now() - started).toBeLessThan(200)
  })

  it('retries a report the server answered with an error', async () => {
    let calls = 0
    const herdr = await listen(request => {
      calls += 1
      return calls === 1 ? { id: request.id, error: { code: 'busy' } } : ok(request)
    })
    const client = createHerdrClient(env(herdr.path), { attempts: 2, timeoutMs: 200 })

    expect(await client.reportState({ state: 'idle', message: undefined, seq: 1, sessionId: undefined })).toBe(true)
    expect(herdr.requests.length).toBe(2)
  })

  it('gives up when the whole report budget is spent, however many attempts remain', async () => {
    // A listener that never answers is what a wedged or half-started server
    // looks like from inside the pane. The budget covers the whole report, so a
    // server that never answers cannot be asked five times for the price of one.
    const herdr = await listen(() => undefined)
    const client = createHerdrClient(env(herdr.path), { attempts: 5, timeoutMs: 25 })
    const started = Date.now()

    expect(await client.reportState({ state: 'idle', message: undefined, seq: 1, sessionId: undefined })).toBe(false)
    // The wire count belongs to the scheduler, not the contract: a timer that
    // fires a hair before the deadline has fully elapsed leaves a sliver for one
    // more connection, which is what CI produced. The budget promises fewer
    // requests than attempts, and a regression that spends every attempt still
    // fails here.
    expect(herdr.requests.length).toBeLessThan(5)
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('treats an error answer as undelivered', async () => {
    const herdr = await listen(request => ({ id: request.id, error: { code: 'invalid_agent' } }))
    const client = createHerdrClient(env(herdr.path), { attempts: 1 })

    expect(await client.reportState({ state: 'idle', message: undefined, seq: 1, sessionId: undefined })).toBe(false)
  })

  it('ignores an answer meant for another request', async () => {
    const herdr = await listen(() => ({ id: 'someone-else', result: {} }))
    const client = createHerdrClient(env(herdr.path), { attempts: 1, timeoutMs: 20 })

    expect(await client.reportState({ state: 'idle', message: undefined, seq: 1, sessionId: undefined })).toBe(false)
  })

  it('sends the newest state instead of every state it passed through', async () => {
    const herdr = await listen(ok)
    const client = createHerdrClient(env(herdr.path))

    const pending = Promise.all([
      client.reportState({ state: 'working', message: undefined, seq: 1, sessionId: undefined }),
      client.reportState({ state: 'blocked', message: 'approval needed · Bash', seq: 2, sessionId: undefined }),
      client.reportState({ state: 'idle', message: undefined, seq: 3, sessionId: undefined }),
    ])

    // A state describes the pane now, so the one still waiting to be sent is
    // replaced rather than replayed; the pane's own history is not Herdr's.
    expect(await pending).toEqual([true, true, true])
    expect(herdr.requests.map(request => request.params?.seq)).toEqual([1, 3])
    expect(herdr.requests.at(-1)?.params?.state).toBe('idle')
  })

  it('keeps a session and its tokens in the order they were decided', async () => {
    const herdr = await listen(ok)
    const client = createHerdrClient(env(herdr.path))

    await Promise.all([
      client.reportSession({ sessionId: 'tui-session-1', seq: 1, reason: 'startup' }),
      client.reportMetadata({ dsh_session: 'tui-session-1', dsh_cwd: '/tmp/project' }),
      client.reportState({ state: 'idle', message: undefined, seq: 2, sessionId: 'tui-session-1' }),
    ])

    expect(herdr.requests.map(request => request.method)).toEqual([
      'pane.report_agent_session',
      'pane.report_metadata',
      'pane.report_agent',
    ])
  })

  it('keeps reporting after one report is lost', async () => {
    let calls = 0
    const herdr = await listen(request => {
      calls += 1
      return calls === 1 ? undefined : ok(request)
    })
    const client = createHerdrClient(env(herdr.path), { attempts: 1, timeoutMs: 30 })

    expect(await client.reportState({ state: 'working', message: undefined, seq: 1, sessionId: undefined })).toBe(false)
    expect(await client.reportState({ state: 'idle', message: undefined, seq: 2, sessionId: undefined })).toBe(true)
  })

  it('drops what was still waiting when the pane stops being an agent', async () => {
    const herdr = await listen(() => undefined)
    const client = createHerdrClient(env(herdr.path), { attempts: 1, timeoutMs: 40 })

    const inFlight = client.reportState({ state: 'working', message: undefined, seq: 1, sessionId: undefined })
    const waiting = client.reportSession({ sessionId: 'tui-session-1', seq: 2, reason: 'startup' })
    await new Promise(resolve => setTimeout(resolve, 5))
    client.stop()

    // Herdr ignores the release of a pane nothing has claimed, so a report that
    // landed after it would claim the row back for a process on its way out.
    expect(await waiting).toBe(false)
    expect(herdr.requests.length).toBe(1)
    expect(await inFlight).toBe(false)

    // A stopped transport is not a broken one: the surface may still ask.
    expect(await client.reportState({ state: 'idle', message: undefined, seq: 3, sessionId: undefined })).toBe(true)
    expect(herdr.requests.length).toBe(1)
  })

  it('settles after the report already on the wire', async () => {
    const herdr = await listen(() => undefined)
    const client = createHerdrClient(env(herdr.path), { attempts: 2, timeoutMs: 120 })
    const order: string[] = []

    const report = client.reportState({ state: 'working', message: undefined, seq: 1, sessionId: undefined })
      .then(() => order.push('report'))
    const settled = client.settle().then(() => order.push('settle'))
    await Promise.all([report, settled])

    // The row cannot go back before the report it may yet claim it has landed.
    expect(order).toEqual(['report', 'settle'])
  })

  it('does not retry a report once the pane stops being an agent', async () => {
    const herdr = await listen(() => HANGUP)
    const client = createHerdrClient(env(herdr.path), { attempts: 4, timeoutMs: 5_000 })
    const started = Date.now()

    const report = client.reportState({ state: 'idle', message: undefined, seq: 1, sessionId: undefined })
    await new Promise(resolve => setTimeout(resolve, 5))
    client.stop()

    // The first attempt fails on its own with three attempts and most of the
    // budget left: what stops the retry is the pane no longer being an agent,
    // because one that landed after the release would claim the row back.
    expect(await report).toBe(false)
    expect(herdr.requests.length).toBe(1)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('settles at once when the transport owes nothing', async () => {
    const herdr = await listen(ok)
    const client = createHerdrClient(env(herdr.path), { attempts: 1, timeoutMs: 60 })
    const started = Date.now()

    await client.settle()

    expect(Date.now() - started).toBeLessThan(1_000)
  })
})

describe('acceptedTokens', () => {
  it('clears a token whose value is absent', () => {
    expect(acceptedTokens({ dsh_session: 'x', dsh_cwd: undefined })).toEqual({ dsh_session: 'x', dsh_cwd: null })
  })

  it('clears a value too long to be held whole', () => {
    // Herdr shortens what it cannot hold, and a shortened path reads as a
    // different directory; clearing the token is the only honest answer.
    const long = 'y'.repeat(MAX_METADATA_VALUE_CHARS + 1)
    expect(acceptedTokens({ dsh_cwd: long, dsh_session: 'x' })).toEqual({ dsh_cwd: null, dsh_session: 'x' })
  })

  it('keeps a value at the limit', () => {
    const exact = 'y'.repeat(MAX_METADATA_VALUE_CHARS)
    expect(acceptedTokens({ dsh_cwd: exact })).toEqual({ dsh_cwd: exact })
  })
})

describe('socketEndpoint', () => {
  it('is the path itself where sockets are files', () => {
    if (process.platform === 'win32') return
    expect(socketEndpoint('/tmp/herdr.sock')).toBe('/tmp/herdr.sock')
  })
})
