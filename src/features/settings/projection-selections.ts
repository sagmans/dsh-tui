import type {
  ConfigurationListState,
  ConfigurationModelEffort,
  ConfigurationModels,
  ConfigurationRowView,
} from './contracts.js'
import {
  CONFIGURATION_ACTIONS,
  type ConfigurationProjectionContext,
  type ConfigurationTarget,
} from './projection-types.js'
import { sanitizeConversationText } from '../conversation/projection.js'

const FULL_ACCESS_PRESET = 'danger-full-access'
const CUSTOM_ACCESS_PRESET = 'custom'
const PERMISSION_SETTINGS_NAMESPACE = 'permission'

interface PermissionOption {
  readonly name: string
  readonly value: string
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function permissionOptions(list: ConfigurationListState): {
  readonly current: string | undefined
  readonly options: readonly PermissionOption[]
} {
  const sessionId = list.current
  const projection = sessionId === undefined ? undefined : list.byId[sessionId]?.projectionValues?.permissions
  if (!record(projection) || !Array.isArray(projection.options)) return { current: undefined, options: [] }
  const options = projection.options.flatMap((candidate): PermissionOption[] => {
    if (!record(candidate) || typeof candidate.value !== 'string' || typeof candidate.name !== 'string') return []
    return candidate.value === CUSTOM_ACCESS_PRESET ? [] : [{ name: candidate.name, value: candidate.value }]
  })
  return { current: typeof projection.currentValue === 'string' ? projection.currentValue : undefined, options }
}

function modelVariantRow(input: {
  readonly catalog: ConfigurationModels
  readonly effort: ConfigurationModelEffort | undefined
  readonly group: ConfigurationModels['groups'][number]
  readonly model: ConfigurationModels['groups'][number]['models'][number]
  readonly targets: Map<string, ConfigurationTarget>
}): ConfigurationRowView {
  const { catalog, effort, group, model, targets } = input
  const selection = {
    provider: group.id,
    model: model.id,
    ...effort === undefined ? {} : { reasoningEffort: effort.id },
  }
  const id = `model:${group.id}:${model.id}:${effort?.id ?? 'default'}`
  const currentEffort = catalog.current.reasoningEffort ?? model.reasoning?.defaultEffort
  const selected = selection.provider === catalog.current.provider
    && selection.model === catalog.current.model
    && selection.reasoningEffort === currentEffort
  targets.set(id, { kind: 'model', selection })
  return {
    actions: selected ? [] : [CONFIGURATION_ACTIONS.model],
    details: sanitizeConversationText([
      model.description,
      effort?.description,
      `provider ${group.name} (${group.id})`,
      `model ${model.id}`,
      `reasoning ${effort?.name ?? 'provider default'}`,
    ].filter(part => part !== undefined).join('\n')),
    id,
    state: selected ? catalog.routable ? 'success' : 'error' : 'idle',
    summary: `${sanitizeConversationText(group.name)} · ${sanitizeConversationText(effort?.name ?? 'default')}`,
    title: sanitizeConversationText(model.name),
  }
}

export function modelRows(context: ConfigurationProjectionContext): readonly ConfigurationRowView[] {
  const catalog = context.data.models
  if (catalog === undefined) return []
  const rows: ConfigurationRowView[] = []
  for (const group of catalog.groups) {
    for (const model of group.models) {
      const efforts = model.reasoning?.efforts ?? []
      const variants = model.reasoning === undefined || efforts.length === 0
        ? [undefined]
        : model.reasoning.defaultEffort === undefined
          ? [undefined, ...efforts]
          : efforts
      for (const effort of variants) {
        rows.push(modelVariantRow({ catalog, effort, group, model, targets: context.targets }))
      }
    }
  }
  const currentEffort = catalog.current.reasoningEffort
    ?? catalog.groups.find(group => group.id === catalog.current.provider)?.models
      .find(model => model.id === catalog.current.model)?.reasoning?.defaultEffort
  const currentId = `model:${catalog.current.provider}:${catalog.current.model}:${currentEffort ?? 'default'}`
  if (!rows.some(row => row.id === currentId)) {
    rows.unshift({
      actions: [],
      details: 'Current selection is not advertised by the provider catalog.',
      id: `model-current:${catalog.current.provider}:${catalog.current.model}:${currentEffort ?? 'default'}`,
      state: catalog.routable ? 'success' : 'error',
      summary: `${sanitizeConversationText(catalog.current.provider)} · ${sanitizeConversationText(currentEffort ?? 'default')}`,
      title: sanitizeConversationText(catalog.current.model),
    })
  }
  for (const failure of catalog.failures) {
    rows.push({
      actions: [],
      details: sanitizeConversationText(failure.message),
      id: `model-failure:${failure.id}`,
      state: 'error',
      summary: 'catalog unavailable',
      title: sanitizeConversationText(failure.name),
    })
  }
  return rows
}

export function accessRows(
  list: ConfigurationListState,
  context: ConfigurationProjectionContext,
): readonly ConfigurationRowView[] {
  const { current, options } = permissionOptions(list)
  const rows = options.map((option): ConfigurationRowView => {
    const id = `access:${option.value}`
    const selected = option.value === current
    context.targets.set(id, { kind: 'access', preset: option.value })
    return {
      actions: selected ? [] : [CONFIGURATION_ACTIONS.access],
      details: option.value === FULL_ACCESS_PRESET
        ? 'Unrestricted host access. Review risk before selecting.'
        : `Permission preset ${sanitizeConversationText(option.value)}`,
      id,
      state: option.value === FULL_ACCESS_PRESET ? 'warning' : selected ? 'success' : 'idle',
      summary: selected ? 'current session' : option.value === FULL_ACCESS_PRESET ? 'unrestricted · current session' : 'current session',
      title: sanitizeConversationText(option.name),
    }
  })
  const namespace = context.data.settings?.namespaces.find(candidate => candidate.ns === PERMISSION_SETTINGS_NAMESPACE)
  const defaultPreset = record(namespace?.value) && typeof namespace.value.defaultPreset === 'string'
    ? namespace.value.defaultPreset
    : undefined
  if (namespace === undefined || defaultPreset === undefined) return rows
  for (const option of options) {
    const id = `access-default:${option.value}`
    const selected = option.value === defaultPreset
    context.targets.set(id, { kind: 'access-default', namespace, preset: option.value })
    rows.push({
      actions: context.data.settings?.writable === true && !selected
        ? [CONFIGURATION_ACTIONS.accessDefault]
        : [],
      details: option.value === FULL_ACCESS_PRESET
        ? 'New sessions start with unrestricted host access. Review risk before selecting.'
        : `New sessions start with ${sanitizeConversationText(option.value)} access.`,
      id,
      state: option.value === FULL_ACCESS_PRESET ? 'warning' : selected ? 'success' : 'idle',
      summary: selected ? 'default · new sessions' : 'available · new sessions',
      title: `${sanitizeConversationText(option.name)} · default`,
    })
  }
  return rows
}
