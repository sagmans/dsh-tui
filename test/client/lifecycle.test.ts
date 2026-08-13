import assert from 'node:assert/strict'
import { test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { InProcessApiClient } from '@deepseek-ai/dsh-host-apiproxy'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ClientPlaneMount } from '../../src/client/context.js'
import { mountClientPlane } from '../../src/client/context.js'

const UNREACHED_CLIENT_API = new InProcessApiClient({
  fetch: () => Promise.reject(new Error('client API fixture must remain unused')),
})
// Lifecycle seams need identity only; runtime behavior is covered by integration tests.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const CLIENT_SERVICES = {
  remote: { $mount() {}, $on() {}, $dispatch() {} },
  sessions: { list: {}, open() {}, clear() {} },
  workspaces: { list: {}, startSession() {}, create() {} },
} as unknown as Pick<ClientPlaneMount, 'remote' | 'sessions' | 'workspaces'>

function apiFixture(): ApiProxy {
  // Fixture remains inert unless lifecycle ownership regresses into host I/O.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return {
    sessions: {},
    subagents: {},
    host: {},
    workspace: {},
    skills: {},
    agentPresets: {},
    events: {},
    goals: {},
    settings: {},
    credentials: {},
    llm: {},
    downloads: {},
    respond: () => Promise.resolve({ accepted: true }),
  } as unknown as ApiProxy
}

test('publishes the facade only after private client readiness', async () => {
  const host = new Context()
  const privateClient = new Context()
  let privateDisposed = false
  privateClient.effect(() => () => { privateDisposed = true })
  let releaseReady: (() => void) | undefined
  const ready = new Promise<void>(resolve => { releaseReady = resolve })
  const mounting = mountClientPlane(host, apiFixture(), {
    createContext: () => privateClient,
    mount: () => Promise.resolve({ ready, api: UNREACHED_CLIENT_API, ...CLIENT_SERVICES }),
  })

  assert.equal(host.get('tuiClient'), undefined)
  releaseReady?.()
  await mounting
  assert.notEqual(host.get('tuiClient'), undefined)

  await host.fiber.dispose()
  assert.equal(privateDisposed, true)
})

test('disposes failed private startup without publishing host state', async () => {
  const host = new Context()
  const privateClient = new Context()
  let privateDisposed = false
  privateClient.effect(() => () => { privateDisposed = true })
  const failure = new Error('private mount failed')

  await assert.rejects(
    mountClientPlane(host, apiFixture(), {
      createContext: () => privateClient,
      mount: () => Promise.reject(failure),
    }),
    failure,
  )
  assert.equal(host.get('tuiClient'), undefined)
  assert.equal(privateDisposed, true)
})

test('keeps client-plane service names out of the host context', async () => {
  const host = new Context()
  const privateClient = new Context()
  privateClient.provide('connection', {})
  privateClient.provide('remote', CLIENT_SERVICES.remote)
  privateClient.provide('sessions', CLIENT_SERVICES.sessions)

  await mountClientPlane(host, apiFixture(), {
    createContext: () => privateClient,
    mount: () => Promise.resolve({
      ready: Promise.resolve(),
      api: UNREACHED_CLIENT_API,
      remote: CLIENT_SERVICES.remote,
      sessions: CLIENT_SERVICES.sessions,
      workspaces: CLIENT_SERVICES.workspaces,
    }),
  })

  assert.equal(host.get('connection'), undefined)
  assert.equal(host.get('remote'), undefined)
  assert.equal(host.get('sessions'), undefined)
  assert.notEqual(host.get('tuiClient'), undefined)

  await host.fiber.dispose()
})
