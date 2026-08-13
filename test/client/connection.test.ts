import assert from 'node:assert/strict'
import { test } from 'vitest'
import type {
  ApiProxy,
  ClientResponse,
  EventsApi,
  HostFrame,
  MuxFrame,
  RpcRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import { InProcessApiClient, RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import { createInProcessConnection } from '../../src/client/connection.js'

const RECONNECT_BACKOFF_MS = 1
const HOST_DESCRIPTION = {
  version: '0.1.0-rc.6',
  cwd: '/workspace',
  attachedSessions: 0,
  canOpenPath: false,
}

interface ApiFixtureControl {
  readonly responses: ClientResponse[]
  describeCalls: number
  muxCalls: number
  releaseFirstMux?: Promise<void>
}

function fixtureControl(): ApiFixtureControl {
  return { responses: [], describeCalls: 0, muxCalls: 0 }
}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>(resolve => {
    signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
}

async function* waitForAbort<Frame>(
  signal: AbortSignal,
  release?: Promise<void>,
): AsyncGenerator<RpcRequest<Frame>> {
  yield* []
  await (release === undefined ? aborted(signal) : Promise.race([release, aborted(signal)]))
}

function apiFixture(control = fixtureControl()): ApiProxy {
  // Fixture intentionally implements only carrier paths exercised here.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return {
    sessions: {},
    subagents: {},
    host: {
      describe: (request: RpcRequest<Record<string, never>>) => {
        control.describeCalls += 1
        return Promise.resolve({
          rpcId: request.rpcId,
          result: { ok: true, value: HOST_DESCRIPTION },
        })
      },
    },
    workspace: {},
    skills: {},
    agentPresets: {},
    events: {
      mux: (_request: Parameters<EventsApi['mux']>[0], signal: AbortSignal) => {
        const release = control.muxCalls === 0 ? control.releaseFirstMux : undefined
        control.muxCalls += 1
        return waitForAbort<MuxFrame>(signal, release)
      },
      host: (_request: Parameters<EventsApi['host']>[0], signal: AbortSignal) => waitForAbort<HostFrame>(signal),
    },
    goals: {},
    settings: {},
    credentials: {},
    llm: {},
    downloads: {},
    respond: (message: ClientResponse) => {
      control.responses.push(message)
      return Promise.resolve({ accepted: true })
    },
  } as unknown as ApiProxy
}

test('provides a loopback-only connection handle over the in-process carrier', async () => {
  const control = fixtureControl()
  const api = apiFixture(control)
  const connection = createInProcessConnection(api, {
    rpc: { call: () => Promise.resolve({ ok: true, value: undefined }) },
  })

  assert.equal(connection.isLoopback, true)
  assert.equal(connection.api instanceof InProcessApiClient, true)
  assert.equal(connection.hostDescription.getSnapshot(), undefined)

  const response: ClientResponse = {
    type: 'client-response',
    rpcId: RpcId('fixture-response'),
    result: { ok: true, value: { outcome: 'approved' } },
  }
  assert.deepEqual(await connection.api.respond(response), { accepted: true })
  assert.deepEqual(control.responses, [response])
})

test('publishes readiness after streams open and retracts it on stop', async () => {
  const api = apiFixture()
  const connection = createInProcessConnection(api, {
    rpc: { call: () => Promise.resolve({ ok: true, value: undefined }) },
  })
  const descriptions: Array<typeof HOST_DESCRIPTION | undefined> = []
  const unsubscribe = connection.hostDescription.subscribe(() => {
    descriptions.push(connection.hostDescription.getSnapshot())
  })
  const loop = connection.start({})

  await connection.ready
  assert.deepEqual(connection.hostDescription.getSnapshot(), HOST_DESCRIPTION)

  loop.stop()
  assert.equal(connection.hostDescription.getSnapshot(), undefined)
  assert.deepEqual(descriptions, [HOST_DESCRIPTION, undefined])
  unsubscribe()
})

test('recovers both streams after one generation closes', async () => {
  let releaseFirstMux: (() => void) | undefined
  const control = fixtureControl()
  control.releaseFirstMux = new Promise<void>(resolve => { releaseFirstMux = resolve })
  const connection = createInProcessConnection(apiFixture(control), {
    config: {
      backoffBaseMs: RECONNECT_BACKOFF_MS,
      backoffFactor: 1,
      backoffMaxMs: RECONNECT_BACKOFF_MS,
    },
    rpc: { call: () => Promise.resolve({ ok: true, value: undefined }) },
  })
  const states: string[] = []
  let releaseReconnected: (() => void) | undefined
  const reconnected = new Promise<void>(resolve => { releaseReconnected = resolve })
  const loop = connection.start({
    onStateChange(state) {
      states.push(state)
      if (states.filter(candidate => candidate === 'connected').length === 2) releaseReconnected?.()
    },
  })

  await connection.ready
  releaseFirstMux?.()
  await reconnected

  assert.deepEqual(states, ['connected', 'reconnecting', 'connected'])
  assert.equal(control.describeCalls, 2)
  assert.equal(control.muxCalls, 2)
  loop.stop()
})
