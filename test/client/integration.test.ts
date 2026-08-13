import assert from 'node:assert/strict'
import { test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { InvokeRemoteRequest, TypertGateway } from '@deepseek-ai/dsh-api-gateway/types'
import type {
  ApiProxy,
  EventsApi,
  HostFrame,
  MuxFrame,
  RpcRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import { mountClientPlane } from '../../src/client/context.js'

const HOST_DESCRIPTION = {
  version: '0.1.0-rc.6',
  cwd: '/workspace',
  attachedSessions: 0,
  canOpenPath: false,
}

async function* openStream<Frame>(signal: AbortSignal): AsyncGenerator<RpcRequest<Frame>> {
  yield* []
  await new Promise<void>(resolve => {
    signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
}

function apiFixture(): ApiProxy {
  // Shared runtime startup needs only baseline, description, and stream paths.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return {
    sessions: {
      list: (request: RpcRequest<{ cursor?: string }>) => Promise.resolve({
        rpcId: request.rpcId,
        result: { ok: true, value: { items: [] } },
      }),
    },
    host: {
      describe: (request: RpcRequest<Record<string, never>>) => Promise.resolve({
        rpcId: request.rpcId,
        result: { ok: true, value: HOST_DESCRIPTION },
      }),
    },
    workspace: {
      list: (request: RpcRequest<Record<string, never>>) => Promise.resolve({
        rpcId: request.rpcId,
        result: { ok: true, value: { items: [], archivedSessionIds: [] } },
      }),
    },
    events: {
      mux: (_request: Parameters<EventsApi['mux']>[0], signal: AbortSignal) => openStream<MuxFrame>(signal),
      host: (_request: Parameters<EventsApi['host']>[0], signal: AbortSignal) => openStream<HostFrame>(signal),
    },
    respond: () => Promise.resolve({ accepted: true }),
  } as unknown as ApiProxy
}

const gateway: TypertGateway = {
  invoke(_request: InvokeRemoteRequest): Promise<unknown> {
    return Promise.reject(new Error('unexpected Remote invocation during startup'))
  },
}

test('mounts shared Harness runtime services inside an isolated client context', async () => {
  const host = new Context()
  host.provide('typertGateway', gateway)

  try {
    const client = await mountClientPlane(host, apiFixture())

    assert.equal(host.get('connection'), undefined)
    assert.equal(host.get('sessions'), undefined)
    assert.equal(host.get('workspaces'), undefined)
    assert.notEqual(client.remote, undefined)
    assert.notEqual(client.sessions, undefined)
    assert.notEqual(client.workspaces, undefined)
    assert.equal(host.get('tuiClient'), client)
  } finally {
    await host.fiber.dispose()
  }
})
