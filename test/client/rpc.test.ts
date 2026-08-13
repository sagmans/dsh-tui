import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { InvokeRemoteRequest, TypertGateway } from '@deepseek-ai/dsh-api-gateway/types'
import { TypertLookupFailure } from '@deepseek-ai/dsh-typert-protocol'
import { createInProcessRpc } from '../../src/client/rpc.js'

const RPC_CHANNEL = '/api'
const RPC_ENDPOINT = 'fixture/read'
const INVALID_ENDPOINT = '../fixture'
const INVALID_TARGET_ERROR = /invalid RPC target/u
const LOOKUP_FAILURE = {
  code: 'session-not-found',
  message: 'session missing',
  details: { sessionId: 'missing' },
} as const

class FixtureGateway implements TypertGateway {
  readonly requests: InvokeRemoteRequest[] = []
  result: unknown = { value: 42 }

  invoke(request: InvokeRemoteRequest): Promise<unknown> {
    this.requests.push(request)
    if (this.result instanceof Error) return Promise.reject(this.result)
    return Promise.resolve(this.result)
  }
}

test('routes valid Remote calls directly into the host gateway', async () => {
  const gateway = new FixtureGateway()
  const rpc = createInProcessRpc(gateway)
  const result = await rpc.call(RPC_CHANNEL, RPC_ENDPOINT, { args: { id: 'one' } })

  assert.deepEqual(result, { ok: true, value: { value: 42 } })
  assert.deepEqual(gateway.requests, [{
    namespace: 'fixture',
    method: 'read',
    args: { id: 'one' },
  }])
})

test('preserves lookup-policy failures and normalizes gateway infrastructure failures', async () => {
  const gateway = new FixtureGateway()
  const rpc = createInProcessRpc(gateway)

  gateway.result = new TypertLookupFailure(LOOKUP_FAILURE)
  assert.deepEqual(await rpc.call(RPC_CHANNEL, RPC_ENDPOINT, { args: {} }), {
    ok: false,
    error: LOOKUP_FAILURE,
  })

  gateway.result = new Error('typert gateway: fixture/read: service missing')
  assert.deepEqual(await rpc.call(RPC_CHANNEL, RPC_ENDPOINT, { args: {} }), {
    ok: false,
    error: {
      code: 'internal',
      message: 'typert gateway: fixture/read: service missing',
      details: {},
    },
  })
})

test('rejects malformed targets and honors pre-aborted calls', async () => {
  const gateway = new FixtureGateway()
  const rpc = createInProcessRpc(gateway)
  const abort = new AbortController()
  abort.abort(new Error('caller stopped'))

  await assert.rejects(rpc.call(RPC_CHANNEL, INVALID_ENDPOINT, { args: {} }), INVALID_TARGET_ERROR)
  assert.deepEqual(await rpc.call(RPC_CHANNEL, RPC_ENDPOINT, { args: {} }, abort.signal), {
    ok: false,
    error: { code: 'cancelled', message: 'caller stopped', details: {} },
  })
  assert.deepEqual(gateway.requests, [])
})
