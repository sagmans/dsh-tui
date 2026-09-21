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

  it('gives up once the attempt budget is spent', async () => {
    // A listener that never answers is what a wedged or half-started server
    // looks like from inside the pane.
    const herdr = await listen(() => undefined)
    const client = createHerdrClient(env(herdr.path), { attempts: 2, timeoutMs: 20 })

    expect(await client.reportState({ state: 'idle', message: undefined, seq: 1, sessionId: undefined })).toBe(false)
    expect(herdr.requests.length).toBe(2)
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

  it('delivers reports in the order the surface decided them', async () => {
    const herdr = await listen(ok)
    const client = createHerdrClient(env(herdr.path))

    await Promise.all([
      client.reportState({ state: 'working', message: undefined, seq: 1, sessionId: undefined }),
      client.reportState({ state: 'blocked', message: 'approval needed · Bash', seq: 2, sessionId: undefined }),
      client.reportState({ state: 'idle', message: undefined, seq: 3, sessionId: undefined }),
    ])

    expect(herdr.requests.map(request => request.params?.seq)).toEqual([1, 2, 3])
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
})

describe('acceptedTokens', () => {
  it('drops an absent value rather than sending undefined', () => {
    expect(acceptedTokens({ dsh_session: 'x', dsh_cwd: undefined })).toEqual({ dsh_session: 'x' })
  })

  it('drops a value Herdr would refuse the whole report over', () => {
    const long = 'y'.repeat(MAX_METADATA_VALUE_CHARS + 1)
    expect(acceptedTokens({ dsh_cwd: long, dsh_session: 'x' })).toEqual({ dsh_session: 'x' })
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
