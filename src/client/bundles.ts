import * as Cordis from '@deepseek-ai/cordis'
import * as ClientUiSlots from '@deepseek-ai/dsh-client-ui-slots'

const CLIENT_PLUGIN_IDS = {
  typert: '@deepseek-ai/dsh-typert-registry',
  gateway: '@deepseek-ai/dsh-api-gateway',
  remotes: '@deepseek-ai/dsh-api-remotes',
  runtime: '@deepseek-ai/dsh-client-runtime',
} as const
const CLIENT_PLUGIN_IMPORTS = {
  typert: () => import('@deepseek-ai/dsh-typert-registry/client'),
  gateway: () => import('@deepseek-ai/dsh-api-gateway/client'),
  remotes: () => import('@deepseek-ai/dsh-api-remotes/client'),
  runtime: () => import('@deepseek-ai/dsh-client-runtime/client'),
} as const
const CLIENT_EXTERNALS = new Map<string, unknown>([
  ['@deepseek-ai/cordis', Cordis],
  ['@deepseek-ai/dsh-client-ui-slots', ClientUiSlots],
])
const MISSING_HANDOFF_ERROR = 'client bundle completed without registration'
const DUPLICATE_HANDOFF_ERROR = 'client bundle registered twice'
const WINDOW_PROPERTY = 'window'
const MODULE_LOADER_PROPERTY = '__ModuleLoader__'

export interface ClientPlugin {
  readonly apply: (ctx: Cordis.Context) => unknown
  readonly inject?: readonly string[]
}

interface ClientBundleHandoff {
  readonly id: string
  readonly factory: (require: (specifier: string) => unknown) => ClientPlugin
}

export interface SharedClientPlugins {
  readonly gateway: ClientPlugin
  readonly remotes: ClientPlugin
  readonly runtime: ClientPlugin
  readonly typert: ClientPlugin
}

function isPlugin(value: unknown): value is ClientPlugin {
  return typeof value === 'object'
    && value !== null
    && 'apply' in value
    && typeof value.apply === 'function'
}

let sharedPlugins: Promise<SharedClientPlugins> | undefined

async function captureSharedClientPlugins(): Promise<SharedClientPlugins> {
  const existingWindow: unknown = Reflect.get(globalThis, WINDOW_PROPERTY)
  const hadWindow = typeof existingWindow === 'object' && existingWindow !== null
  const target = hadWindow ? existingWindow : globalThis
  const previousLoader: unknown = Reflect.get(target, MODULE_LOADER_PROPERTY)
  const handoffs = new Map<string, ClientBundleHandoff>()
  Reflect.set(target, MODULE_LOADER_PROPERTY, {
    load(handoff: ClientBundleHandoff) {
      if (handoffs.has(handoff.id)) throw new Error(`${DUPLICATE_HANDOFF_ERROR}: ${handoff.id}`)
      handoffs.set(handoff.id, handoff)
    },
  })
  if (!hadWindow) Reflect.set(globalThis, WINDOW_PROPERTY, target)

  try {
    await Promise.all(Object.values(CLIENT_PLUGIN_IMPORTS).map(load => load()))
  } finally {
    if (previousLoader === undefined) Reflect.deleteProperty(target, MODULE_LOADER_PROPERTY)
    else Reflect.set(target, MODULE_LOADER_PROPERTY, previousLoader)
    if (!hadWindow) Reflect.deleteProperty(globalThis, WINDOW_PROPERTY)
  }

  const materialize = (id: string): ClientPlugin => {
    const handoff = handoffs.get(id)
    if (handoff === undefined) throw new Error(`${MISSING_HANDOFF_ERROR}: ${id}`)
    const plugin = handoff.factory(specifier => {
      if (!CLIENT_EXTERNALS.has(specifier)) throw new Error(`unexpected client bundle external: ${specifier}`)
      return CLIENT_EXTERNALS.get(specifier)
    })
    if (!isPlugin(plugin)) throw new Error(`client bundle did not export a Cordis plugin: ${id}`)
    return plugin
  }

  return {
    typert: materialize(CLIENT_PLUGIN_IDS.typert),
    gateway: materialize(CLIENT_PLUGIN_IDS.gateway),
    remotes: materialize(CLIENT_PLUGIN_IDS.remotes),
    runtime: materialize(CLIENT_PLUGIN_IDS.runtime),
  }
}

export function loadSharedClientPlugins(): Promise<SharedClientPlugins> {
  sharedPlugins ??= captureSharedClientPlugins()
  return sharedPlugins
}
