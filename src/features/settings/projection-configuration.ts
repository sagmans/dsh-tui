import type {
  ConfigurationActionView,
  ConfigurationListState,
  ConfigurationRowView,
  ConfigurationSettingsCatalog,
} from './contracts.js'
import {
  CONFIGURATION_ACTIONS,
  type ConfigurationProjectionContext,
} from './projection-types.js'
import { sanitizeConversationText } from '../conversation/projection.js'
import { sanitizeText } from '../sessions/projection.js'
import { LOCALE_SETTINGS_NAMESPACE } from '../../services/locale.js'
import { THEME_SETTINGS_NAMESPACE } from '../../services/theme.js'
import { pluginCredentialRefs } from './projection-plugin-settings.js'

const MAX_JSON_LENGTH = 2_000
const SECRET_CONFIGURED = '[configured]'
const SECRET_UNCONFIGURED = '[not configured]'
const PREFERENCE_NAMESPACES = new Set([LOCALE_SETTINGS_NAMESPACE, THEME_SETTINGS_NAMESPACE])

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedJson(value: unknown): string {
  let serialized: string
  try {
    serialized = JSON.stringify(value, undefined, 2)
  } catch {
    serialized = String(value)
  }
  const sanitized = sanitizeConversationText(serialized)
  return sanitized.length <= MAX_JSON_LENGTH ? sanitized : `${sanitized.slice(0, MAX_JSON_LENGTH)}…`
}

function secretValue(value: unknown, path: readonly string[], replacement: string): unknown {
  if (path.length === 0) return replacement
  if (!record(value)) return value
  const [head, ...tail] = path
  if (head === undefined || !(head in value)) return value
  return { ...value, [head]: secretValue(value[head], tail, replacement) }
}

function redactedSettingsValue(
  value: unknown,
  secrets: ConfigurationSettingsCatalog['namespaces'][number]['secrets'],
): unknown {
  return secrets.reduce(
    (current, secret) => secretValue(current, secret.path, secret.set ? SECRET_CONFIGURED : SECRET_UNCONFIGURED),
    value,
  )
}

export function presetRows(
  list: ConfigurationListState,
  context: ConfigurationProjectionContext,
): readonly ConfigurationRowView[] {
  const catalog = context.data.presets
  if (catalog === undefined) return []
  const currentId = list.current
  const session = currentId === undefined ? undefined : list.byId[currentId]
  return catalog.presets.map((preset): ConfigurationRowView => {
    const selected = preset.id === session?.agentPreset
    const actions: ConfigurationActionView[] = []
    if (session?.blank === true && !selected && preset.broken === undefined) actions.push(CONFIGURATION_ACTIONS.presetSelect)
    if (!preset.isDefault && preset.broken === undefined) actions.push(CONFIGURATION_ACTIONS.presetDefault)
    actions.push(CONFIGURATION_ACTIONS.presetView)
    if (catalog.authorable) actions.push(CONFIGURATION_ACTIONS.presetCopy)
    if (preset.trust === 'user' && catalog.hasDocument) actions.push(CONFIGURATION_ACTIONS.presetOpen)
    if (preset.trust === 'user') actions.push(CONFIGURATION_ACTIONS.presetRemove)
    const id = `preset:${preset.id}`
    context.targets.set(id, { id: preset.id, kind: 'preset', trust: preset.trust })
    const content = context.data.presetContents.get(preset.id)
    return {
      actions,
      details: sanitizeConversationText([
        preset.description,
        preset.broken === undefined ? undefined : `broken: ${preset.broken}`,
        `id ${preset.id}`,
        `trust ${preset.trust}`,
        `default ${String(preset.isDefault)}`,
        content === undefined ? undefined : `\n${content}`,
      ].filter(part => part !== undefined).join('\n')),
      id,
      state: preset.broken === undefined ? selected ? 'success' : 'idle' : 'error',
      summary: [preset.trust, preset.isDefault ? 'default' : undefined, selected ? 'current' : undefined]
        .filter(part => part !== undefined).join(' · '),
      title: sanitizeConversationText(preset.name ?? preset.id),
    }
  })
}

export function settingsRows(context: ConfigurationProjectionContext): readonly ConfigurationRowView[] {
  const catalog = context.data.settings
  if (catalog === undefined) return []
  return catalog.namespaces
    .filter(namespace => !PREFERENCE_NAMESPACES.has(namespace.ns))
    .map((namespace): ConfigurationRowView => {
      const actions: ConfigurationActionView[] = []
      if (catalog.hasDocument) actions.push(CONFIGURATION_ACTIONS.settingsOpen)
      if (catalog.writable && namespace.user !== undefined) actions.push(CONFIGURATION_ACTIONS.settingsReset)
      const id = `settings:${namespace.ns}`
      context.targets.set(id, { kind: 'settings', namespace: namespace.ns, revision: namespace.revision })
      const secretSummary = namespace.secrets.length === 0
        ? 'secrets none'
        : namespace.secrets.map(secret => `${secret.path.join('.')} ${secret.set ? 'configured' : 'not configured'}`).join('\n')
      return {
        actions,
        details: sanitizeConversationText([
          `applies ${namespace.applies}`,
          `revision ${namespace.revision}`,
          secretSummary,
          boundedJson(redactedSettingsValue(namespace.value, namespace.secrets)),
        ].join('\n')),
        id,
        state: namespace.applies === 'restart' ? 'warning' : 'idle',
        summary: `${namespace.applies} · revision ${namespace.revision}`,
        title: sanitizeText(namespace.ns),
      }
    })
}

export function credentialRefs(settings: ConfigurationSettingsCatalog | undefined): readonly string[] {
  const refs = new Set<string>()
  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (!record(value)) return
    for (const [key, item] of Object.entries(value)) {
      if (key === 'apiKeyEnv' && typeof item === 'string' && item.trim() !== '') refs.add(item)
      else visit(item)
    }
  }
  for (const namespace of settings?.namespaces ?? []) visit(namespace.value)
  for (const ref of pluginCredentialRefs(settings)) refs.add(ref)
  return [...refs]
}

export function credentialRows(context: ConfigurationProjectionContext): readonly ConfigurationRowView[] {
  if (context.data.credentials === undefined) return []
  return Object.entries(context.data.credentials).map(([ref, credential]): ConfigurationRowView => {
    context.targets.set(`credential:${ref}`, { kind: 'credential', ref })
    return {
      actions: credential.writable
        ? credential.configured
          ? [CONFIGURATION_ACTIONS.credentialSet, CONFIGURATION_ACTIONS.credentialUnset]
          : [CONFIGURATION_ACTIONS.credentialSet]
        : [],
      details: `Reference ${sanitizeText(ref)}\nValue is write-only and never displayed.`,
      id: `credential:${ref}`,
      state: credential.configured ? 'success' : 'warning',
      summary: credential.configured
        ? `${sanitizeText(credential.source ?? 'configured')} · ${credential.writable ? 'writable' : 'read only'}`
        : credential.writable ? 'not configured' : 'not configured · read only',
      title: sanitizeText(ref),
    }
  })
}
