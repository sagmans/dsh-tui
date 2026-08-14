import type { TuiClientFacade } from '../../client/context.js'
import type { ConfigurationListState, ConfigurationPort } from './contracts.js'
import { createApiConfigurationPort } from './port-api.js'
import { createRemoteConfigurationPort } from './port-remote.js'

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function configurationListState(client: TuiClientFacade): ConfigurationListState {
  const state = client.sessions.list.getSnapshot()
  const byId: Record<string, ConfigurationListState['byId'][string]> = {}
  for (const summary of Object.values(state.byId)) {
    if (summary === undefined) continue
    const projectionValues: unknown = summary.projectionValues
    byId[String(summary.id)] = {
      blank: summary.blank,
      ...summary.agentPreset === undefined ? {} : { agentPreset: summary.agentPreset },
      ...record(projectionValues) ? { projectionValues } : {},
    }
  }
  return { byId, current: state.current }
}

export function createConfigurationPort(client: TuiClientFacade): ConfigurationPort {
  return { ...createApiConfigurationPort(client), ...createRemoteConfigurationPort(client) }
}
