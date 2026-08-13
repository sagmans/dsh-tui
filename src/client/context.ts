import { Context } from '@deepseek-ai/cordis'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway/types'
import type { ConnectionHandle, IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import type { ISessions, IWorkspaces } from '@deepseek-ai/dsh-client-runtime/client'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy/api'
import { loadSharedClientPlugins } from './bundles.js'
import { createInProcessConnection, type TuiConnectionHandle } from './connection.js'
import { createInProcessRpc } from './rpc.js'

const TUI_CLIENT_SERVICE = 'tuiClient'
const PRIVATE_CONNECTION_SERVICE = 'connection'
const PRIVATE_CONNECTION_PLUGIN_NAME = 'tui-in-process-connection'
const CLIENT_TUIPERT_PLUGIN_NAME = 'tui-client-typert'
const CLIENT_GATEWAY_PLUGIN_NAME = 'tui-client-gateway'
const CLIENT_REMOTES_PLUGIN_NAME = 'tui-client-remotes'
const CLIENT_RUNTIME_PLUGIN_NAME = 'tui-client-runtime'
const CLIENT_SERVICE_ERROR = 'private client services unavailable after activation'

export interface TuiClientFacade {
  readonly api: IApiClient
  readonly context: Context
  readonly remote: ClientRemote
  readonly sessions: ISessions
  readonly workspaces: IWorkspaces
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly tuiClient: TuiClientFacade
  }
}

export interface ClientPlaneMount {
  readonly api: IApiClient
  readonly ready: Promise<void>
  readonly remote: ClientRemote
  readonly sessions: ISessions
  readonly workspaces: IWorkspaces
}

export interface ClientPlaneSeams {
  readonly createContext?: () => Context
  readonly mount?: (client: Context, host: Context, apiProxy: ApiProxy) => Promise<ClientPlaneMount>
}

function isService(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

function hasMethod(value: unknown, method: string): boolean {
  return isService(value) && typeof Reflect.get(value, method) === 'function'
}

function isTypertGateway(value: unknown): value is TypertGateway {
  return hasMethod(value, 'invoke')
}

async function mountSharedRuntime(client: Context, host: Context, apiProxy: ApiProxy): Promise<ClientPlaneMount> {
  const typertGateway: unknown = host.get('typertGateway')
  if (!isTypertGateway(typertGateway)) throw new Error(CLIENT_SERVICE_ERROR)
  const connection = createInProcessConnection(apiProxy, {
    rpc: createInProcessRpc(typertGateway),
  })
  const plugins = await loadSharedClientPlugins()
  await client.plugin({
    name: PRIVATE_CONNECTION_PLUGIN_NAME,
    apply: ctx => { ctx.provide(PRIVATE_CONNECTION_SERVICE, connection) },
  })
  await client.plugin({ name: CLIENT_TUIPERT_PLUGIN_NAME, ...plugins.typert })
  await client.plugin({ name: CLIENT_GATEWAY_PLUGIN_NAME, ...plugins.gateway })
  await client.plugin({ name: CLIENT_REMOTES_PLUGIN_NAME, ...plugins.remotes })
  await client.plugin({ name: CLIENT_RUNTIME_PLUGIN_NAME, ...plugins.runtime })
  const remote = client.get('remote')
  const sessions = client.get('sessions')
  const workspaces = client.get('workspaces')
  if (!isService(remote) || !isService(sessions) || !isService(workspaces)) {
    throw new Error(CLIENT_SERVICE_ERROR)
  }

  return {
    api: connection.api,
    ready: connection.ready,
    remote,
    sessions,
    workspaces,
  }
}

export async function mountClientPlane(
  host: Context,
  apiProxy: ApiProxy,
  seams: ClientPlaneSeams = {},
): Promise<TuiClientFacade> {
  const client = seams.createContext?.() ?? new Context()
  try {
    const mounted = await (seams.mount ?? mountSharedRuntime)(client, host, apiProxy)
    await mounted.ready
    const facade = Object.freeze({
      api: mounted.api,
      context: client,
      remote: mounted.remote,
      sessions: mounted.sessions,
      workspaces: mounted.workspaces,
    } satisfies TuiClientFacade)
    host.provide(TUI_CLIENT_SERVICE, facade)
    host.effect(() => () => client.fiber.dispose(), 'dsh-tui: private client context')
    return facade
  } catch (error) {
    await client.fiber.dispose()
    throw error
  }
}

export type { ConnectionHandle, TuiConnectionHandle }
