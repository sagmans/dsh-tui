import type {
  ConfigurationActionView,
  ConfigurationProviderModel,
  ConfigurationRowView,
} from './contracts.js'
import {
  CONFIGURATION_ACTIONS,
  type ConfigurationProjectionContext,
  type ConfigurationProviderTarget,
} from './projection-types.js'
import { sanitizeConversationText } from '../conversation/projection.js'

const PI_AI_NAMESPACE = 'llm-pi-ai'

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function configurationValueAt(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const segment of path) {
    if (!record(current) || !(segment in current)) return undefined
    current = current[segment]
  }
  return current
}

function hasConfigurationPath(value: unknown, path: readonly string[]): boolean {
  if (path.length === 0) return value !== undefined
  let current = value
  for (const segment of path) {
    if (!record(current) || !Object.hasOwn(current, segment)) return false
    current = current[segment]
  }
  return true
}

export function providerCredentialRef(profile: Readonly<Record<string, unknown>> | undefined): string | undefined {
  const value = profile?.apiKeyEnv
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function providerText(
  profile: Readonly<Record<string, unknown>> | undefined,
  field: string,
  fallback: string,
): string {
  const value = profile?.[field]
  return typeof value === 'string' && value.trim() !== '' ? value : fallback
}

export function providerModels(profile: Readonly<Record<string, unknown>> | undefined): readonly ConfigurationProviderModel[] {
  if (!Array.isArray(profile?.models)) return []
  return profile.models.flatMap((candidate): ConfigurationProviderModel[] => {
    if (!record(candidate) || typeof candidate.id !== 'string' || candidate.id.trim() === '') return []
    return [{ ...candidate, id: candidate.id }]
  })
}

function providerTarget(
  context: ConfigurationProjectionContext,
  entry: NonNullable<ConfigurationProjectionContext['data']['providers']>[number],
): ConfigurationProviderTarget | undefined {
  const namespace = context.data.settings?.namespaces.find(candidate => candidate.ns === entry.settingsNs)
  if (namespace === undefined) return undefined
  const value = configurationValueAt(namespace.value, entry.settingsPath)
  const profile = record(value) ? value : undefined
  const credentialRef = providerCredentialRef(profile)
  return {
    credential: credentialRef === undefined ? undefined : context.data.credentials?.[credentialRef],
    credentialRef,
    entry,
    kind: 'provider',
    namespace,
    profile,
    removable: entry.settingsPath.length > 0
      && hasConfigurationPath(namespace.user, entry.settingsPath)
      && !hasConfigurationPath(namespace.base, entry.settingsPath),
  }
}

function providerActions(
  target: ConfigurationProviderTarget | undefined,
  writable: boolean,
): readonly ConfigurationActionView[] {
  if (target === undefined) return []
  const actions: ConfigurationActionView[] = [CONFIGURATION_ACTIONS.providerDiscover]
  if (writable) {
    actions.unshift(CONFIGURATION_ACTIONS.providerEdit)
    actions.push(CONFIGURATION_ACTIONS.providerCredential, CONFIGURATION_ACTIONS.providerModelAdd)
    if (target.removable) actions.push(CONFIGURATION_ACTIONS.providerRemove)
  }
  return actions
}

function modelRows(
  context: ConfigurationProjectionContext,
  target: ConfigurationProviderTarget,
  writable: boolean,
): ConfigurationRowView[] {
  const rows = providerModels(target.profile).map((model, index): ConfigurationRowView => {
    const id = `provider-model:${target.entry.provider}:${model.id}`
    context.targets.set(id, { index, kind: 'provider-model', model, provider: target })
    const capacities = [
      typeof model.contextWindow === 'number' ? `context ${String(model.contextWindow)}` : undefined,
      typeof model.maxTokens === 'number' ? `output ${String(model.maxTokens)}` : undefined,
    ].filter(value => value !== undefined).join(' · ')
    return {
      actions: writable
        ? [CONFIGURATION_ACTIONS.providerModelEdit, CONFIGURATION_ACTIONS.providerModelRemove]
        : [],
      details: sanitizeConversationText([
        `provider ${target.entry.provider}`,
        `model ${model.id}`,
        capacities === '' ? undefined : capacities,
      ].filter(value => value !== undefined).join('\n')),
      id,
      state: target.entry.active ? 'success' : 'warning',
      summary: sanitizeConversationText(model.name ?? model.id),
      title: `↳ ${sanitizeConversationText(model.name ?? model.id)}`,
    }
  })
  for (const candidate of context.data.discoveredModels.get(target.entry.provider) ?? []) {
    if (providerModels(target.profile).some(model => model.id === candidate.id)) continue
    const id = `provider-candidate:${target.entry.provider}:${candidate.id}`
    context.targets.set(id, { candidate, kind: 'provider-candidate', provider: target })
    rows.push({
      actions: writable ? [CONFIGURATION_ACTIONS.providerModelAdopt] : [],
      details: `Discovered from ${sanitizeConversationText(target.entry.displayName)}. Review before adding.`,
      id,
      state: 'idle',
      summary: 'available from endpoint',
      title: `+ ${sanitizeConversationText(candidate.name ?? candidate.id)}`,
    })
  }
  return rows
}

export function providerRows(context: ConfigurationProjectionContext): readonly ConfigurationRowView[] {
  const catalog = context.data.providers
  const settings = context.data.settings
  if (catalog === undefined || settings === undefined) return []
  const rows: ConfigurationRowView[] = []
  const createNamespace = settings.namespaces.find(namespace => namespace.ns === PI_AI_NAMESPACE)
  if (settings.writable && createNamespace !== undefined) {
    context.targets.set('provider:create', { kind: 'provider-create', namespace: createNamespace })
    rows.push({
      actions: [CONFIGURATION_ACTIONS.providerCreate],
      details: 'Declare a custom pi-ai route through a staged terminal form.',
      id: 'provider:create',
      state: 'idle',
      summary: 'endpoint · protocol · model · optional key',
      title: 'Add custom provider',
    })
  }
  for (const entry of catalog) {
    const target = providerTarget(context, entry)
    const configured = target?.profile !== undefined
    const credentialState = target?.credentialRef === undefined
      ? 'native auth'
      : target.credential?.configured === true
        ? 'key configured'
        : 'key missing'
    const id = `provider:${entry.provider}`
    if (target !== undefined) context.targets.set(id, target)
    rows.push({
      actions: providerActions(target, settings.writable),
      details: sanitizeConversationText([
        `route ${entry.provider}`,
        `namespace ${entry.settingsNs || 'unavailable'}`,
        `endpoint ${providerText(target?.profile, 'baseURL', 'provider default')}`,
        `protocol ${providerText(target?.profile, 'api', 'provider default')}`,
        credentialState,
      ].join('\n')),
      id,
      state: entry.active && configured && credentialState !== 'key missing'
        ? 'success'
        : entry.active ? 'warning' : 'error',
      summary: `${entry.active ? 'active' : 'dormant'} · ${configured ? 'configured' : 'not configured'} · ${credentialState}`,
      title: sanitizeConversationText(entry.displayName),
    })
    if (target !== undefined) rows.push(...modelRows(context, target, settings.writable))
  }
  return rows
}
