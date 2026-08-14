import type {
  ConfigurationActionView,
  ConfigurationCredentialView,
  ConfigurationRowView,
  ConfigurationSettingsCatalog,
} from './contracts.js'
import {
  CONFIGURATION_ACTIONS,
  type ConfigurationPluginSettingTarget,
  type ConfigurationProjectionContext,
} from './projection-types.js'
import { sanitizeText } from '../sessions/projection.js'

const SHELL_NAMESPACE = 'shell'
const AGENT_LOOP_NAMESPACE = 'agent-loop'
const WEB_SEARCH_TITLE = 'DeepSeek search'
const API_KEY_FIELD = 'apiKey'
export const WEB_SEARCH_NAMESPACE = 'web-search-deepseek'
export const DEFAULT_WEB_SEARCH_CREDENTIAL_REF = 'DEEPSEEK_API_KEY'

interface PluginFieldSpec {
  readonly field: string
  readonly label: string
  readonly valueKind: 'number' | 'text'
}

interface PluginCardSpec {
  readonly fields: readonly PluginFieldSpec[]
  readonly namespace: string
  readonly title: string
}

const PLUGIN_CARDS = Object.freeze([
  {
    namespace: SHELL_NAMESPACE,
    title: 'Shell',
    fields: Object.freeze([
      { field: 'timeoutMs', label: 'Timeout (ms)', valueKind: 'number' },
      { field: 'maxOutputBytes', label: 'Max output (bytes)', valueKind: 'number' },
    ]),
  },
  {
    namespace: AGENT_LOOP_NAMESPACE,
    title: 'Agent loop',
    fields: Object.freeze([
      { field: 'maxParallelToolCalls', label: 'Parallel tool calls', valueKind: 'number' },
    ]),
  },
  {
    namespace: WEB_SEARCH_NAMESPACE,
    title: WEB_SEARCH_TITLE,
    fields: Object.freeze([
      { field: 'baseURL', label: 'Base URL', valueKind: 'text' },
      { field: 'maxUses', label: 'Max uses', valueKind: 'number' },
    ]),
  },
] as const satisfies readonly PluginCardSpec[])

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function scalarText(value: unknown): string {
  return typeof value === 'number' || typeof value === 'string' ? sanitizeText(String(value)) : 'unset'
}

function fieldRow(
  context: ConfigurationProjectionContext,
  catalog: ConfigurationSettingsCatalog,
  namespace: ConfigurationSettingsCatalog['namespaces'][number],
  card: PluginCardSpec,
  field: PluginFieldSpec,
): ConfigurationRowView {
  const value = record(namespace.value) ? namespace.value[field.field] : undefined
  const base = record(namespace.base) ? namespace.base[field.field] : undefined
  const overridden = record(namespace.user) && Object.hasOwn(namespace.user, field.field)
  const target: ConfigurationPluginSettingTarget = {
    base,
    field: field.field,
    kind: 'plugin-setting',
    label: `${card.title} · ${field.label}`,
    namespace: namespace.ns,
    overridden,
    revision: namespace.revision,
    value,
    valueKind: field.valueKind,
  }
  const actions: ConfigurationActionView[] = []
  if (catalog.writable) {
    actions.push(CONFIGURATION_ACTIONS.pluginSettingEdit)
    if (overridden) actions.push(CONFIGURATION_ACTIONS.pluginSettingReset)
  }
  const id = `plugin-setting:${namespace.ns}:${field.field}`
  context.targets.set(id, target)
  return {
    actions,
    details: [
      `namespace ${namespace.ns}`,
      `field ${field.field}`,
      `effective ${scalarText(value)}`,
      `base ${scalarText(base)}`,
      `revision ${namespace.revision}`,
    ].join('\n'),
    id,
    state: overridden ? 'success' : 'idle',
    summary: `${scalarText(value)} · ${overridden ? 'overridden' : 'inherited'}`,
    title: target.label,
  }
}

function credentialRef(namespace: ConfigurationSettingsCatalog['namespaces'][number]): string {
  const ref = record(namespace.value) ? namespace.value.apiKeyEnv : undefined
  return typeof ref === 'string' && ref.trim() !== '' ? ref : DEFAULT_WEB_SEARCH_CREDENTIAL_REF
}

function credentialRow(
  context: ConfigurationProjectionContext,
  catalog: ConfigurationSettingsCatalog,
  namespace: ConfigurationSettingsCatalog['namespaces'][number],
  credential: ConfigurationCredentialView | undefined,
): ConfigurationRowView {
  const ref = credentialRef(namespace)
  const id = `plugin-setting:${namespace.ns}:${API_KEY_FIELD}`
  const label = `${WEB_SEARCH_TITLE} · API key`
  context.targets.set(id, {
    credentialRef: ref,
    field: API_KEY_FIELD,
    kind: 'plugin-setting',
    label,
    namespace: namespace.ns,
    revision: namespace.revision,
    valueKind: 'credential',
  })
  const writable = catalog.writable && (credential?.writable ?? true)
  return {
    actions: writable ? [CONFIGURATION_ACTIONS.pluginSettingCredential] : [],
    details: [
      `namespace ${namespace.ns}`,
      `credential ${sanitizeText(ref)}`,
      'Value is write-only and never displayed.',
    ].join('\n'),
    id,
    state: credential?.configured === true ? 'success' : 'warning',
    summary: credential?.configured === true ? 'configured · write only' : 'not configured · write only',
    title: label,
  }
}

export function pluginSettingRows(context: ConfigurationProjectionContext): readonly ConfigurationRowView[] {
  const catalog = context.data.settings
  if (catalog === undefined) return []
  const rows: ConfigurationRowView[] = []
  for (const card of PLUGIN_CARDS) {
    const namespace = catalog.namespaces.find(candidate => candidate.ns === card.namespace)
    if (namespace === undefined) continue
    for (const field of card.fields) rows.push(fieldRow(context, catalog, namespace, card, field))
    if (card.namespace === WEB_SEARCH_NAMESPACE) {
      const ref = credentialRef(namespace)
      rows.push(credentialRow(context, catalog, namespace, context.data.credentials?.[ref]))
    }
  }
  return rows
}

export function pluginCredentialRefs(settings: ConfigurationSettingsCatalog | undefined): readonly string[] {
  const namespace = settings?.namespaces.find(candidate => candidate.ns === WEB_SEARCH_NAMESPACE)
  return namespace === undefined ? [] : [credentialRef(namespace)]
}
