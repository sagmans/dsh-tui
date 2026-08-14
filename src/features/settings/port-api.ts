import type { TuiClientFacade } from '../../client/context.js'
import type { ConfigurationPort } from './contracts.js'
import { configurationFailure, configurationSuccess } from './port-result.js'

const AGENT_PRESET_SETTINGS_NAMESPACE = 'agent-presets'
const ACCESS_COMMAND_PREFIX = '/permission '

type ModelAccessPort = Pick<ConfigurationPort, 'models' | 'selectModel' | 'selectAccess'>
type ProviderPort = Pick<ConfigurationPort, 'providerCatalog' | 'discoverProviderModels' | 'mutateSettings'>
type PresetPort = Pick<
  ConfigurationPort,
  | 'presets'
  | 'selectPreset'
  | 'defaultPreset'
  | 'readPreset'
  | 'copyPreset'
  | 'openPreset'
  | 'removePreset'
>
type SettingsCredentialPort = Pick<
  ConfigurationPort,
  | 'settings'
  | 'openSettings'
  | 'resetSetting'
  | 'credentials'
  | 'setCredential'
  | 'unsetCredential'
>

function modelAccessPort(client: TuiClientFacade): ModelAccessPort {
  const { api } = client
  return {
    async models(sessionId) {
      const response = await api.sessions.models({ sessionId })
      return response.result.ok ? { ok: true, value: response.result.value } : configurationFailure(response.result.error)
    },
    async selectModel(sessionId, selection) {
      const response = await api.sessions.selectModel({
        sessionId,
        provider: selection.provider,
        model: selection.model,
        ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
      })
      return response.result.ok ? configurationSuccess() : configurationFailure(response.result.error)
    },
    async selectAccess(sessionId, preset) {
      const session = client.sessions.binding(sessionId)?.session
      if (session === undefined) {
        return { ok: false, error: { code: 'session-unavailable', message: 'Session unavailable.' } }
      }
      const result = await session.command(`${ACCESS_COMMAND_PREFIX}${preset}`)
      if (!result.ok) return configurationFailure(result.error)
      return result.value.matched
        ? configurationSuccess()
        : { ok: false, error: { code: 'unknown-command', message: 'Permission command unavailable.' } }
    },
  }
}

function providerPort(client: TuiClientFacade): ProviderPort {
  const { api } = client
  return {
    async providerCatalog() {
      const response = await api.llm.providers({})
      return response.result.ok
        ? { ok: true, value: response.result.value.providers }
        : configurationFailure(response.result.error)
    },
    async discoverProviderModels(request) {
      const response = await api.llm.discoverModels({
        settingsNs: request.settingsNs,
        ...request.provider === undefined ? {} : { provider: request.provider },
        ...request.baseURL === undefined ? {} : { baseURL: request.baseURL },
        ...request.api === undefined ? {} : { api: request.api },
        ...request.apiKey === undefined ? {} : { apiKey: request.apiKey },
      })
      return response.result.ok
        ? { ok: true, value: response.result.value.models }
        : configurationFailure(response.result.error)
    },
    async mutateSettings(namespace, operations, revision) {
      const response = await api.settings.mutate({
        ns: namespace,
        ops: operations.map(operation => ({ ...operation, path: [...operation.path] })),
        expectedRevision: revision,
      })
      return response.result.ok ? configurationSuccess() : configurationFailure(response.result.error)
    },
  }
}

function presetPort(client: TuiClientFacade): PresetPort {
  const { api } = client
  return {
    async presets() {
      const response = await api.agentPresets.list({})
      return response.result.ok ? { ok: true, value: response.result.value } : configurationFailure(response.result.error)
    },
    async selectPreset(sessionId, preset) {
      const response = await api.agentPresets.select({ sessionId, agentPreset: preset })
      return response.result.ok ? configurationSuccess() : configurationFailure(response.result.error)
    },
    async defaultPreset(preset) {
      const response = await api.settings.update({ ns: AGENT_PRESET_SETTINGS_NAMESPACE, patch: { default: preset } })
      return response.result.ok ? configurationSuccess() : configurationFailure(response.result.error)
    },
    async readPreset(preset) {
      const response = await api.agentPresets.read({ agentPreset: preset })
      return response.result.ok
        ? { ok: true, value: response.result.value.content }
        : configurationFailure(response.result.error)
    },
    async copyPreset(request) {
      const response = await api.agentPresets.copy({
        from: request.from,
        agentPreset: request.id,
        ...request.name === undefined ? {} : { name: request.name },
      })
      return response.result.ok ? configurationSuccess() : configurationFailure(response.result.error)
    },
    async openPreset(preset) {
      const response = await api.agentPresets.openDocument({ agentPreset: preset })
      return response.result.ok ? { ok: true, value: response.result.value } : configurationFailure(response.result.error)
    },
    async removePreset(preset) {
      const response = await api.agentPresets.remove({ agentPreset: preset })
      return response.result.ok ? configurationSuccess() : configurationFailure(response.result.error)
    },
  }
}

function settingsCredentialPort(client: TuiClientFacade): SettingsCredentialPort {
  const { api } = client
  return {
    async settings() {
      const response = await api.settings.describe({})
      return response.result.ok ? { ok: true, value: response.result.value } : configurationFailure(response.result.error)
    },
    async openSettings() {
      const response = await api.settings.openDocument({})
      return response.result.ok ? configurationSuccess() : configurationFailure(response.result.error)
    },
    async resetSetting(namespace, revision) {
      const response = await api.settings.replace({ ns: namespace, section: {}, expectedRevision: revision })
      return response.result.ok ? configurationSuccess() : configurationFailure(response.result.error)
    },
    async credentials(refs) {
      const response = await api.credentials.describe({ refs: [...refs] })
      return response.result.ok
        ? { ok: true, value: response.result.value.credentials }
        : configurationFailure(response.result.error)
    },
    async setCredential(ref, value) {
      const response = await api.credentials.set({ ref, value })
      return response.result.ok ? configurationSuccess() : configurationFailure(response.result.error)
    },
    async unsetCredential(ref) {
      const response = await api.credentials.unset({ ref })
      return response.result.ok ? configurationSuccess() : configurationFailure(response.result.error)
    },
  }
}

export function createApiConfigurationPort(
  client: TuiClientFacade,
): ModelAccessPort & ProviderPort & PresetPort & SettingsCredentialPort {
  return {
    ...modelAccessPort(client),
    ...providerPort(client),
    ...presetPort(client),
    ...settingsCredentialPort(client),
  }
}
