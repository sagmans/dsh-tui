import type {
  CordisDynamicPackageId,
  CordisDynamicPluginId,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { TuiClientFacade } from '../../client/context.js'
import type { ConfigurationPort } from './contracts.js'
import {
  configurationBusinessFailure,
  configurationFailure,
  configurationSuccess,
} from './port-result.js'

const REQUEST_ID_NONE = null
const APPROVE_FUTURE_VERSIONS = false

type InventoryPort = Pick<
  ConfigurationPort,
  'plugins' | 'extensions' | 'runExtension' | 'stopExtension' | 'removeExtension'
>

function pluginId(value: string): CordisDynamicPluginId {
  // Inventory-originated opaque identities retain their generated Remote brands at this boundary.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as CordisDynamicPluginId
}

function packageId(value: string): CordisDynamicPackageId {
  // Inventory-originated opaque identities retain their generated Remote brands at this boundary.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as CordisDynamicPackageId
}

export function createRemoteConfigurationPort(client: TuiClientFacade): InventoryPort {
  const { remote } = client
  return {
    async plugins() {
      const response = await remote.pluginInventory.list()
      return response.ok ? { ok: true, value: response.value.entries } : configurationFailure(response.error)
    },
    async extensions() {
      const response = await remote.dynamicCordisRunner.inventory()
      return response.ok ? { ok: true, value: response.value } : configurationFailure(response.error)
    },
    async runExtension(request) {
      const response = await remote.dynamicCordisRunner.runHostHalf(
        request.agentId,
        pluginId(request.pluginId),
        packageId(request.packageId),
        request.mode,
        REQUEST_ID_NONE,
        APPROVE_FUTURE_VERSIONS,
      )
      if (!response.ok) return configurationFailure(response.error)
      return response.value.ok ? configurationSuccess() : configurationBusinessFailure(response.value)
    },
    async stopExtension(agentId, dynamicPluginId) {
      const response = await remote.dynamicCordisRunner.stopFromPanel(agentId, pluginId(dynamicPluginId))
      if (!response.ok) return configurationFailure(response.error)
      return response.value.ok || response.value.reason === 'not-running'
        ? configurationSuccess()
        : configurationBusinessFailure(response.value)
    },
    async removeExtension(agentId, dynamicPluginId) {
      const response = await remote.dynamicCordisRunner.undefineFromPanel(agentId, pluginId(dynamicPluginId))
      if (!response.ok) return configurationFailure(response.error)
      return response.value.ok ? configurationSuccess() : configurationBusinessFailure(response.value)
    },
  }
}
