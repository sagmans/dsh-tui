import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { TuiThemePreference } from '../../contracts/theme.js'
import { createActionCursor } from '../catalog/root.js'
import type {
  ConfigurationActionId,
  ConfigurationController,
  ConfigurationControllerOptions,
  ConfigurationDiscoveredModel,
  ConfigurationInputView,
  ConfigurationProviderModel,
  ConfigurationResult,
  ConfigurationSection,
  ConfigurationSettingsOperation,
  ConfigurationSnapshotView,
} from './contracts.js'
import {
  credentialRefs,
  projectConfiguration,
  type ConfigurationPluginSettingTarget,
  type ConfigurationProjectionData,
  type ConfigurationProviderTarget,
  type ConfigurationTarget,
  type ProjectedConfiguration,
} from './projection.js'
import {
  providerCredentialRef,
  providerModels,
} from './projection-providers.js'
import { sanitizeConversationText } from '../conversation/projection.js'
import { sanitizeText } from '../sessions/projection.js'
import {
  isLocaleId,
  LOCALE_PREFERENCE_FIELD,
  LOCALE_SETTINGS_NAMESPACE,
  type LocaleId,
} from '../../services/locale.js'
import {
  isThemePreference,
  THEME_PREFERENCE_FIELD,
  THEME_SETTINGS_NAMESPACE,
} from '../../services/theme.js'

export type * from './contracts.js'

const FIRST_INDEX = 0
const FULL_ACCESS_PRESET = 'danger-full-access'
const COPY_SUFFIX = '-copy'
const PI_AI_NAMESPACE = 'llm-pi-ai'
const ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u
const API_KEY_PATTERN = /^[\u0021-\u007E]+$/u
const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/u
const QUOTED_VALUE_PATTERN = /^(?:".*"|'.*')$/u
const PLUGIN_NUMBER_ERROR = 'Plugin setting must be a finite number.'
const PLUGIN_TARGET_STALE_ERROR = 'Plugin setting target is stale.'
const PROVIDER_CREATE_FIELDS = Object.freeze([
  'route', 'displayName', 'baseURL', 'api', 'modelId', 'apiKey',
] as const)
const PROVIDER_EDIT_FIELDS = Object.freeze(['displayName', 'baseURL', 'api'] as const)
const DEEPSEEK_EDIT_FIELDS = Object.freeze(['baseURL'] as const)
const PROVIDER_MODEL_FIELDS = Object.freeze([
  'modelId', 'modelName', 'contextWindow', 'maxTokens',
] as const)
const MODEL_OPTIONAL_FIELDS = new Set(['name', 'contextWindow', 'maxTokens'])
const SECTION_NAMES: readonly ConfigurationSection[] = Object.freeze([
  'models',
  'providers',
  'access',
  'presets',
  'settings',
  'credentials',
  'plugins',
  'extensions',
])
const CONFIRMED_ACTIONS = new Set<ConfigurationActionId>([
  'provider.remove',
  'provider.model.remove',
  'settings.reset',
  'credential.unset',
  'preset.remove',
  'extension.stop',
  'extension.remove',
])

type ProviderInputField =
  | 'api'
  | 'apiKey'
  | 'baseURL'
  | 'contextWindow'
  | 'displayName'
  | 'maxTokens'
  | 'modelId'
  | 'modelName'
  | 'route'

type ProviderInputMode = 'create' | 'credential' | 'edit' | 'model-add' | 'model-edit'

interface ProviderInputDraft {
  readonly fields: readonly ProviderInputField[]
  readonly mode: ProviderInputMode
  readonly target: ConfigurationTarget
  readonly values: Partial<Record<ProviderInputField, string>>
  step: number
}

const PROVIDER_FIELD_LABELS: Readonly<Record<ProviderInputField, string>> = Object.freeze({
  api: 'API protocol',
  apiKey: 'API key (optional)',
  baseURL: 'Base URL',
  contextWindow: 'Context window (optional)',
  displayName: 'Display name (optional)',
  maxTokens: 'Output token limit (optional)',
  modelId: 'Model id',
  modelName: 'Model name (optional)',
  route: 'Provider id',
})

function errorText(error: unknown): string {
  return sanitizeText(error instanceof Error ? error.message : String(error))
}

function recordValue(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function derivedCredentialRef(provider: string): string {
  return `${provider.toUpperCase().replaceAll(/[^A-Z0-9]+/gu, '_')}_API_KEY`
}

function positiveInteger(value: string): number | undefined {
  if (value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : Number.NaN
}

type PluginValueTarget = ConfigurationPluginSettingTarget & (
  | { readonly valueKind: 'number' }
  | { readonly valueKind: 'text' }
)

interface PluginSettingPlan {
  readonly nextValue: unknown
  readonly operation: ConfigurationSettingsOperation
}

function pluginSettingPlan(target: PluginValueTarget, input: string): PluginSettingPlan | undefined {
  const text = input.trim()
  if (text === '') return { nextValue: undefined, operation: { op: 'unset', path: [target.field] } }
  switch (target.valueKind) {
    case 'number': {
      const parsed = Number(text)
      return Number.isFinite(parsed)
        ? { nextValue: parsed, operation: { op: 'set', path: [target.field], value: parsed } }
        : undefined
    }
    case 'text': return { nextValue: text, operation: { op: 'set', path: [target.field], value: text } }
    default: {
      const exhaustive: never = target
      return exhaustive
    }
  }
}

function samePluginSettingIdentity(
  target: ConfigurationPluginSettingTarget | undefined,
  current: ConfigurationTarget | undefined,
): target is ConfigurationPluginSettingTarget {
  if (target === undefined || current?.kind !== 'plugin-setting') return false
  if (current.namespace !== target.namespace
    || current.field !== target.field
    || current.valueKind !== target.valueKind) return false
  return target.valueKind !== 'credential'
    || (current.valueKind === 'credential' && current.credentialRef === target.credentialRef)
}

class SettingsControllerService implements ConfigurationController {
  private readonly actionCursor = createActionCursor<ConfigurationActionId>()
  private busyCount = 0
  private confirmation: ConfigurationActionId | undefined
  private confirmationToken: string | undefined
  private credentials: ConfigurationProjectionData['credentials']
  private current: SessionId | undefined
  private readonly discoveredModels = new Map<string, readonly ConfigurationDiscoveredModel[]>()
  private disposed = false
  private error: string | undefined
  private extensions: ConfigurationProjectionData['extensions']
  private input: ConfigurationInputView | undefined
  private inputTarget: string | undefined
  private pluginSettingInputTarget: ConfigurationPluginSettingTarget | undefined
  private readonly listeners = new Set<() => void>()
  private readonly locale: ConfigurationControllerOptions['locale']
  private models: ConfigurationProjectionData['models']
  private notice: string | undefined
  private plugins: ConfigurationProjectionData['plugins']
  private readonly port: ConfigurationControllerOptions['port']
  private providerDraft: ProviderInputDraft | undefined
  private providers: ConfigurationProjectionData['providers']
  private readonly presetContents = new Map<string, string>()
  private presets: ConfigurationProjectionData['presets']
  private publishPending = false
  private readonly resources: Array<() => void>
  private rowIndex = FIRST_INDEX
  private section: ConfigurationSection = SECTION_NAMES[FIRST_INDEX] ?? 'models'
  private secretInput = ''
  private settings: ConfigurationProjectionData['settings']
  private readonly theme: ConfigurationControllerOptions['theme']

  constructor(options: ConfigurationControllerOptions) {
    this.locale = options.locale
    this.port = options.port
    this.theme = options.theme
    this.current = options.list.getSnapshot().current
    this.resources = [
      options.list.subscribe(() => {
        const next = options.list.getSnapshot().current
        if (next !== this.current) {
          this.current = next
          this.clearSessionData()
        }
        this.schedulePublish()
        if (options.navigation.getSnapshot().route === 'settings') void this.refresh()
      }),
      options.navigation.subscribe(() => {
        if (options.navigation.getSnapshot().route === 'settings') void this.activate()
      }),
      options.locale.subscribe(() => { this.schedulePublish() }),
      options.theme.subscribe(() => { this.schedulePublish() }),
    ]
    this.list = options.list
  }

  private readonly list: ConfigurationControllerOptions['list']

  activate(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    return this.refresh()
  }

  cancelInput(): void {
    if (this.input === undefined) return
    this.clearInput()
    this.error = undefined
    this.schedulePublish()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const dispose of this.resources.splice(0).toReversed()) dispose()
    this.secretInput = ''
    this.listeners.clear()
  }

  getSnapshot(): ConfigurationSnapshotView {
    const projected = this.projected()
    const maxIndex = Math.max(FIRST_INDEX, projected.rows.length - 1)
    const rowIndex = Math.min(this.rowIndex, maxIndex)
    const selectedActionId = this.actionCursor.current(projected.rows[rowIndex]?.actions ?? [])
    return Object.freeze({
      busy: this.busyCount > 0,
      confirmation: this.confirmation,
      error: this.error,
      input: this.input,
      rowIndex,
      rows: projected.rows,
      section: this.section,
      sections: SECTION_NAMES,
      selectedActionId,
      status: this.status(projected, rowIndex),
    })
  }

  move(delta: number): void {
    const count = this.projected().rows.length
    if (count === 0 || !Number.isFinite(delta) || delta === 0) return
    const direction = delta < 0 ? -1 : 1
    this.rowIndex = (this.rowIndex + direction + count) % count
    this.actionCursor.reset()
    this.clearConfirmation()
    this.schedulePublish()
  }

  moveAction(delta: number): void {
    const row = this.projected().rows[this.rowIndex]
    if (row === undefined) return
    this.actionCursor.move(row.actions, delta)
    this.clearConfirmation()
    this.schedulePublish()
  }

  moveSection(delta: number): void {
    if (!Number.isFinite(delta) || delta === 0) return
    const currentIndex = SECTION_NAMES.indexOf(this.section)
    const direction = delta < 0 ? -1 : 1
    const section = SECTION_NAMES[(currentIndex + direction + SECTION_NAMES.length) % SECTION_NAMES.length]
    if (section !== undefined) this.selectSection(section)
  }

  perform(action?: ConfigurationActionId): Promise<boolean> {
    if (this.busyCount > 0 || this.input !== undefined) return Promise.resolve(false)
    const projected = this.projected()
    const row = projected.rows[this.rowIndex]
    const selectedAction = action ?? this.actionCursor.current(row?.actions ?? [])
    if (row === undefined
      || selectedAction === undefined
      || !row.actions.some(candidate => candidate.id === selectedAction && candidate.enabled)) {
      return Promise.resolve(false)
    }
    const target = projected.targets.get(row.id)
    if (target === undefined) return Promise.resolve(false)
    this.actionCursor.select(row.actions, selectedAction)
    const needsConfirmation = CONFIRMED_ACTIONS.has(selectedAction)
      || ((selectedAction === 'access.select' && target.kind === 'access'
        || selectedAction === 'access.default' && target.kind === 'access-default')
        && target.preset === FULL_ACCESS_PRESET)
    const token = this.confirmationIdentity(selectedAction, row.id, target)
    if (needsConfirmation && this.confirmationToken !== token) {
      this.confirmation = selectedAction
      this.confirmationToken = token
      this.schedulePublish()
      return Promise.resolve(false)
    }
    this.clearConfirmation()
    return this.dispatch(selectedAction, row.id, target)
  }

  async refresh(): Promise<void> {
    if (this.disposed) return
    this.busyCount += 1
    this.error = undefined
    this.notice = undefined
    this.schedulePublish()
    try {
      await this.loadSection(this.section)
    } catch (error) {
      this.error = errorText(error)
    } finally {
      this.busyCount -= 1
      this.schedulePublish()
    }
  }

  selectRow(index: number): void {
    const rows = this.projected().rows
    if (!Number.isSafeInteger(index) || index < 0 || index >= rows.length) return
    this.rowIndex = index
    this.actionCursor.reset()
    this.clearConfirmation()
    this.schedulePublish()
  }

  selectSection(section: ConfigurationSection): void {
    if (!SECTION_NAMES.includes(section) || section === this.section) return
    this.section = section
    this.rowIndex = FIRST_INDEX
    this.actionCursor.reset()
    this.clearConfirmation()
    this.clearInput()
    this.error = undefined
    this.schedulePublish()
    void this.refresh()
  }

  setInput(value: string): void {
    if (this.input === undefined) return
    const sanitized = sanitizeConversationText(value)
    if (this.input.secret === true) {
      this.secretInput = sanitized
      return
    }
    this.input = { ...this.input, value: sanitized }
  }

  submitInput(): Promise<boolean> {
    const input = this.input
    if (input === undefined || this.busyCount > 0) return Promise.resolve(false)
    if (this.providerDraft !== undefined) return this.submitProviderInput(input)
    const row = this.projected().rows[this.rowIndex]
    const target = row === undefined || row.id !== this.inputTarget
      ? undefined
      : this.projected().targets.get(row.id)
    if (input.kind === 'plugin-setting') {
      return this.submitPluginSettingInput(input, this.pluginSettingInputTarget, target)
    }
    if (input.kind === 'credential') {
      const value = this.secretInput
      if (target?.kind !== 'credential' || value.trim() === '') {
        this.error = value.trim() === '' ? 'Credential cannot be blank.' : 'Credential target is stale.'
        this.schedulePublish()
        return Promise.resolve(false)
      }
      this.clearInput()
      this.schedulePublish()
      return this.runAndRefresh(
        () => this.port.setCredential(target.ref, value),
        'credentials',
        { sensitive: true },
      )
    }
    const id = input.value.trim()
    if (target?.kind !== 'preset' || id === '') {
      this.error = id === '' ? 'Preset id cannot be blank.' : 'Preset target is stale.'
      this.schedulePublish()
      return Promise.resolve(false)
    }
    this.clearInput()
    this.schedulePublish()
    return this.runAndRefresh(() => this.port.copyPreset({ from: target.id, id }), 'presets')
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async syncPreferences(): Promise<void> {
    if (this.disposed) return
    const result = await this.port.settings()
    if (!result.ok || this.disposed) return
    this.settings = result.value
    this.applyPreferenceSettings(result.value)
    this.schedulePublish()
  }

  private beginCredential(rowId: string, target: ConfigurationTarget): boolean {
    if (target.kind !== 'credential') return false
    this.secretInput = ''
    this.inputTarget = rowId
    this.input = { kind: 'credential', secret: true, title: `Set ${sanitizeText(target.ref)}`, value: '' }
    this.schedulePublish()
    return true
  }

  private beginPluginSetting(
    rowId: string,
    target: ConfigurationTarget,
    mode: 'credential' | 'edit',
  ): boolean {
    if (target.kind !== 'plugin-setting') return false
    if (mode === 'credential' && target.valueKind !== 'credential'
      || mode === 'edit' && target.valueKind === 'credential') return false
    this.secretInput = ''
    this.inputTarget = rowId
    this.pluginSettingInputTarget = target
    this.input = {
      kind: 'plugin-setting',
      secret: target.valueKind === 'credential',
      title: target.label,
      value: target.valueKind === 'credential' ? '' : this.pluginSettingValueText(target),
    }
    this.schedulePublish()
    return true
  }

  private beginPresetCopy(rowId: string, target: ConfigurationTarget): boolean {
    if (target.kind !== 'preset') return false
    this.inputTarget = rowId
    this.input = {
      kind: 'preset-copy',
      title: `Copy ${sanitizeText(target.id)}`,
      value: `${sanitizeText(target.id)}${COPY_SUFFIX}`,
    }
    this.schedulePublish()
    return true
  }

  private beginProviderInput(mode: ProviderInputMode, target: ConfigurationTarget): boolean {
    let fields: readonly ProviderInputField[]
    const values: Partial<Record<ProviderInputField, string>> = {}
    switch (mode) {
      case 'create': {
        if (target.kind !== 'provider-create') return false
        fields = PROVIDER_CREATE_FIELDS
        break
      }
      case 'credential': {
        if (target.kind !== 'provider') return false
        fields = ['apiKey']
        break
      }
      case 'edit': {
        if (target.kind !== 'provider') return false
        fields = target.entry.settingsNs === PI_AI_NAMESPACE ? PROVIDER_EDIT_FIELDS : DEEPSEEK_EDIT_FIELDS
        values.displayName = typeof target.profile?.displayName === 'string' ? target.profile.displayName : ''
        values.baseURL = typeof target.profile?.baseURL === 'string' ? target.profile.baseURL : ''
        values.api = typeof target.profile?.api === 'string' ? target.profile.api : ''
        break
      }
      case 'model-add': {
        if (target.kind !== 'provider') return false
        fields = PROVIDER_MODEL_FIELDS
        break
      }
      case 'model-edit': {
        if (target.kind !== 'provider-model') return false
        fields = PROVIDER_MODEL_FIELDS
        values.modelId = target.model.id
        values.modelName = target.model.name ?? ''
        values.contextWindow = target.model.contextWindow === undefined ? '' : String(target.model.contextWindow)
        values.maxTokens = target.model.maxTokens === undefined ? '' : String(target.model.maxTokens)
        break
      }
      default: {
        const exhaustive: never = mode
        return exhaustive
      }
    }
    this.providerDraft = { fields, mode, step: FIRST_INDEX, target, values }
    this.showProviderField()
    return true
  }

  private showProviderField(): void {
    const draft = this.providerDraft
    const field = draft?.fields[draft.step]
    if (draft === undefined || field === undefined) return
    const secret = field === 'apiKey'
    this.secretInput = ''
    this.input = {
      kind: 'provider',
      secret,
      title: PROVIDER_FIELD_LABELS[field],
      value: secret ? '' : draft.values[field] ?? '',
    }
    this.error = undefined
    this.schedulePublish()
  }

  private validateProviderField(draft: ProviderInputDraft, field: ProviderInputField, value: string): string | undefined {
    const trimmed = value.trim()
    if (field === 'route') {
      if (!ROUTE_PATTERN.test(trimmed)) return 'Provider id must start with a lowercase letter and use lowercase letters, numbers, or hyphens.'
      if ((this.providers ?? []).some(provider => provider.provider === trimmed)) return 'Provider id already exists.'
    }
    if ((field === 'baseURL' || field === 'api' || field === 'modelId')
      && draft.mode === 'create' && trimmed === '') return `${PROVIDER_FIELD_LABELS[field]} cannot be blank.`
    if (field === 'modelId' && trimmed === '') return 'Model id cannot be blank.'
    if (field === 'modelId' && draft.mode !== 'create') {
      const provider = this.providerFor(draft.target)
      const editingIndex = draft.target.kind === 'provider-model' ? draft.target.index : -1
      if (providerModels(provider?.profile).some((model, index) => model.id === trimmed && index !== editingIndex)) {
        return 'Model id already exists.'
      }
    }
    if (field === 'apiKey' && draft.mode === 'credential' && trimmed === '') return 'API key cannot be blank.'
    if (field === 'apiKey' && trimmed !== ''
      && (!API_KEY_PATTERN.test(trimmed) || ENV_ASSIGNMENT_PATTERN.test(trimmed) || QUOTED_VALUE_PATTERN.test(trimmed))) {
      return 'API key must be an unquoted printable value, not NAME=value.'
    }
    if ((field === 'contextWindow' || field === 'maxTokens') && Number.isNaN(positiveInteger(trimmed))) {
      return `${PROVIDER_FIELD_LABELS[field]} must be a positive integer.`
    }
    return undefined
  }

  private submitProviderInput(input: ConfigurationInputView): Promise<boolean> {
    const draft = this.providerDraft
    const field = draft?.fields[draft.step]
    if (draft === undefined || field === undefined) return Promise.resolve(false)
    const raw = field === 'apiKey' ? this.secretInput : input.value
    const failure = this.validateProviderField(draft, field, raw)
    if (failure !== undefined) {
      this.error = failure
      this.schedulePublish()
      return Promise.resolve(false)
    }
    draft.values[field] = raw.trim()
    this.secretInput = ''
    draft.step += 1
    if (draft.step < draft.fields.length) {
      this.showProviderField()
      return Promise.resolve(true)
    }
    this.input = undefined
    this.providerDraft = undefined
    this.schedulePublish()
    return this.applyProviderDraft(draft)
  }

  private applyPreferenceSettings(settings: NonNullable<ConfigurationProjectionData['settings']>): void {
    const theme = settings.namespaces.find(namespace => namespace.ns === THEME_SETTINGS_NAMESPACE)
    const themeValue = recordValue(theme?.value) ? theme.value[THEME_PREFERENCE_FIELD] : undefined
    if (isThemePreference(themeValue)) this.theme.setPreference(themeValue)

    const locale = settings.namespaces.find(namespace => namespace.ns === LOCALE_SETTINGS_NAMESPACE)
    const localeValue = recordValue(locale?.value) ? locale.value[LOCALE_PREFERENCE_FIELD] : undefined
    if (isLocaleId(localeValue)) this.locale.setLocale(localeValue)
  }

  private clearConfirmation(): void {
    this.confirmation = undefined
    this.confirmationToken = undefined
  }

  private clearInput(): void {
    this.input = undefined
    this.inputTarget = undefined
    this.pluginSettingInputTarget = undefined
    this.providerDraft = undefined
    this.secretInput = ''
  }

  private clearSessionData(): void {
    this.models = undefined
    this.extensions = undefined
    this.credentials = undefined
    this.providers = undefined
    this.discoveredModels.clear()
    this.presetContents.clear()
    this.rowIndex = FIRST_INDEX
    this.actionCursor.reset()
    this.clearConfirmation()
    this.clearInput()
  }

  private confirmationIdentity(action: ConfigurationActionId, rowId: string, target: ConfigurationTarget): string {
    const version = target.kind === 'settings' || target.kind === 'theme' || target.kind === 'locale'
      ? target.revision
      : target.kind === 'extension'
        ? `${target.plugin.currentPackageId ?? ''}:${target.plugin.latestRun?.packageId ?? ''}:${target.plugin.latestRun?.status ?? ''}`
        : target.kind === 'credential'
          ? this.credentials?.[target.ref]?.configured
          : target.kind === 'access' || target.kind === 'access-default'
            ? target.preset
            : target.kind === 'preset'
              ? target.id
              : undefined
    return JSON.stringify([action, rowId, version])
  }

  private dispatch(action: ConfigurationActionId, rowId: string, target: ConfigurationTarget): Promise<boolean> {
    switch (action) {
      case 'model.select': return this.selectModel(target)
      case 'provider.create': return Promise.resolve(this.beginProviderInput('create', target))
      case 'provider.edit': return Promise.resolve(this.beginProviderInput('edit', target))
      case 'provider.discover': return this.discoverProvider(target)
      case 'provider.remove': return this.removeProvider(target)
      case 'provider.credential': return Promise.resolve(this.beginProviderInput('credential', target))
      case 'provider.model.add': return Promise.resolve(this.beginProviderInput('model-add', target))
      case 'provider.model.edit': return Promise.resolve(this.beginProviderInput('model-edit', target))
      case 'provider.model.remove': return this.removeProviderModel(target)
      case 'provider.model.adopt': return this.adoptProviderModel(target)
      case 'access.select': return this.selectAccess(target)
      case 'access.default': return this.defaultAccess(target)
      case 'preset.select': return this.selectPreset(target)
      case 'preset.default': return this.defaultPreset(target)
      case 'preset.view': return this.viewPreset(target)
      case 'preset.copy': return Promise.resolve(this.beginPresetCopy(rowId, target))
      case 'preset.open': return this.openPreset(target)
      case 'preset.remove': return this.removePreset(target)
      case 'settings.open': return this.runBoolean(() => this.port.openSettings())
      case 'settings.reset': return this.resetSetting(target)
      case 'plugin-setting.edit': return Promise.resolve(this.beginPluginSetting(rowId, target, 'edit'))
      case 'plugin-setting.reset': return this.resetPluginSetting(target)
      case 'plugin-setting.credential': return Promise.resolve(this.beginPluginSetting(rowId, target, 'credential'))
      case 'theme.light': return this.changeTheme(target, 'light')
      case 'theme.dark': return this.changeTheme(target, 'dark')
      case 'theme.system': return this.changeTheme(target, 'system')
      case 'locale.zh': return this.changeLocale(target, 'zh')
      case 'locale.en': return this.changeLocale(target, 'en')
      case 'credential.set': return Promise.resolve(this.beginCredential(rowId, target))
      case 'credential.unset': return this.unsetCredential(target)
      case 'extension.run': return this.runExtension(target)
      case 'extension.stop': return this.stopExtension(target)
      case 'extension.remove': return this.removeExtension(target)
      default: {
        const exhaustive: never = action
        return Promise.resolve(exhaustive)
      }
    }
  }

  private applyProviderDraft(draft: ProviderInputDraft): Promise<boolean> {
    switch (draft.mode) {
      case 'create': return this.createProvider(draft)
      case 'credential': return this.setProviderCredential(draft)
      case 'edit': return this.editProvider(draft)
      case 'model-add': return this.saveProviderModel(draft, false)
      case 'model-edit': return this.saveProviderModel(draft, true)
      default: {
        const exhaustive: never = draft.mode
        return Promise.resolve(exhaustive)
      }
    }
  }

  private createProvider(draft: ProviderInputDraft): Promise<boolean> {
    if (draft.target.kind !== 'provider-create') return Promise.resolve(false)
    const target = draft.target
    const route = draft.values.route ?? ''
    const apiKey = draft.values.apiKey ?? ''
    const credentialRef = derivedCredentialRef(route)
    const profile = {
      ...draft.values.displayName === '' ? {} : { displayName: draft.values.displayName },
      ...apiKey === '' ? {} : { apiKeyEnv: credentialRef },
      api: draft.values.api ?? '',
      baseURL: draft.values.baseURL ?? '',
      models: [{ id: draft.values.modelId ?? '' }],
    }
    const operation: ConfigurationSettingsOperation = {
      op: 'set', path: ['providers', route], value: profile,
    }
    return this.runProviderOperation(async () => {
      const mutation = await this.port.mutateSettings(
        target.namespace.ns,
        [operation],
        target.namespace.revision,
      )
      if (!mutation.ok || apiKey === '') return mutation
      return this.port.setCredential(credentialRef, apiKey)
    }, apiKey !== '')
  }

  private editProvider(draft: ProviderInputDraft): Promise<boolean> {
    if (draft.target.kind !== 'provider') return Promise.resolve(false)
    const operations: ConfigurationSettingsOperation[] = []
    for (const field of draft.fields) {
      const key = field
      const next = draft.values[field] ?? ''
      const current = draft.target.profile?.[key]
      if (next === '' && current !== undefined) {
        operations.push({ op: 'unset', path: [...draft.target.entry.settingsPath, key] })
      } else if (next !== '' && next !== current) {
        operations.push({ op: 'set', path: [...draft.target.entry.settingsPath, key], value: next })
      }
    }
    if (operations.length === 0) return Promise.resolve(true)
    return this.mutateProvider(draft.target, operations)
  }

  private providerFor(target: ConfigurationTarget): ConfigurationProviderTarget | undefined {
    switch (target.kind) {
      case 'provider': return target
      case 'provider-candidate': return target.provider
      case 'provider-model': return target.provider
      case 'access':
      case 'access-default':
      case 'credential':
      case 'extension':
      case 'model':
      case 'plugin':
      case 'plugin-setting':
      case 'preset':
      case 'provider-create':
      case 'settings':
      case 'theme':
      case 'locale': return undefined
      default: {
        const exhaustive: never = target
        return exhaustive
      }
    }
  }

  private modelFromDraft(draft: ProviderInputDraft): ConfigurationProviderModel {
    const contextWindow = positiveInteger(draft.values.contextWindow ?? '')
    const maxTokens = positiveInteger(draft.values.maxTokens ?? '')
    return {
      id: draft.values.modelId ?? '',
      ...draft.values.modelName === '' ? {} : { name: draft.values.modelName },
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
    }
  }

  private saveProviderModel(draft: ProviderInputDraft, editing: boolean): Promise<boolean> {
    const provider = this.providerFor(draft.target)
    if (provider === undefined) return Promise.resolve(false)
    const current = providerModels(provider.profile)
    const model = this.modelFromDraft(draft)
    const editingIndex = draft.target.kind === 'provider-model' ? draft.target.index : -1
    if (current.some((candidate, index) => candidate.id === model.id && index !== editingIndex)) {
      this.error = 'Model id already exists.'
      this.schedulePublish()
      return Promise.resolve(false)
    }
    const models = editing && editingIndex >= 0
      ? current.map((candidate, index) => index === editingIndex
          ? {
              ...Object.fromEntries(Object.entries(candidate).filter(([key]) => !MODEL_OPTIONAL_FIELDS.has(key))),
              ...model,
            }
          : candidate)
      : [...current, model]
    return this.writeProviderModels(provider, models)
  }

  private writeProviderModels(
    provider: ConfigurationProviderTarget,
    models: readonly ConfigurationProviderModel[],
  ): Promise<boolean> {
    return this.mutateProvider(provider, [{
      op: 'set',
      path: [...provider.entry.settingsPath, 'models'],
      value: models.map(model => ({ ...model })),
    }])
  }

  private mutateProvider(
    provider: ConfigurationProviderTarget,
    operations: readonly ConfigurationSettingsOperation[],
  ): Promise<boolean> {
    return this.runProviderOperation(() => this.port.mutateSettings(
      provider.namespace.ns,
      operations,
      provider.namespace.revision,
    ))
  }

  private async runProviderOperation(
    operation: () => Promise<ConfigurationResult<unknown>>,
    sensitive = false,
  ): Promise<boolean> {
    const result = await this.run(operation, { sensitive })
    const failure = result.ok ? undefined : this.error
    if (this.section === 'providers') await this.refresh()
    if (failure !== undefined) {
      this.error = failure
      this.schedulePublish()
    }
    return result.ok
  }

  private discoverProvider(target: ConfigurationTarget): Promise<boolean> {
    const provider = this.providerFor(target)
    if (provider === undefined) return Promise.resolve(false)
    return this.discoverProviderTarget(provider)
  }

  private async discoverProviderTarget(provider: ConfigurationProviderTarget): Promise<boolean> {
    const result = await this.run(() => this.port.discoverProviderModels({
      settingsNs: provider.entry.settingsNs,
      provider: provider.entry.provider,
    }))
    if (!result.ok) return false
    this.discoveredModels.set(provider.entry.provider, result.value)
    this.notice = `${String(result.value.length)} models discovered.`
    this.schedulePublish()
    return true
  }

  private adoptProviderModel(target: ConfigurationTarget): Promise<boolean> {
    if (target.kind !== 'provider-candidate') return Promise.resolve(false)
    const current = providerModels(target.provider.profile)
    if (current.some(model => model.id === target.candidate.id)) return Promise.resolve(true)
    return this.writeProviderModels(target.provider, [...current, { ...target.candidate }])
  }

  private removeProviderModel(target: ConfigurationTarget): Promise<boolean> {
    if (target.kind !== 'provider-model') return Promise.resolve(false)
    const models = providerModels(target.provider.profile).filter((_model, index) => index !== target.index)
    return this.writeProviderModels(target.provider, models)
  }

  private removeProvider(target: ConfigurationTarget): Promise<boolean> {
    if (target.kind !== 'provider' || !target.removable) return Promise.resolve(false)
    const derivedRef = derivedCredentialRef(target.entry.provider)
    return this.runProviderOperation(async () => {
      if (target.credentialRef === derivedRef
        && target.credential?.configured === true
        && target.credential.writable) {
        const credential = await this.port.unsetCredential(derivedRef)
        if (!credential.ok) return credential
      }
      return this.port.mutateSettings(target.namespace.ns, [{
        op: 'unset', path: [...target.entry.settingsPath],
      }], target.namespace.revision)
    })
  }

  private setProviderCredential(draft: ProviderInputDraft): Promise<boolean> {
    if (draft.target.kind !== 'provider') return Promise.resolve(false)
    const target = draft.target
    const value = draft.values.apiKey ?? ''
    const credentialRef = target.credentialRef ?? derivedCredentialRef(target.entry.provider)
    return this.runProviderOperation(async () => {
      if (providerCredentialRef(target.profile) === undefined) {
        const mutation = await this.port.mutateSettings(target.namespace.ns, [{
          op: 'set',
          path: [...target.entry.settingsPath, 'apiKeyEnv'],
          value: credentialRef,
        }], target.namespace.revision)
        if (!mutation.ok) return mutation
      }
      return this.port.setCredential(credentialRef, value)
    }, true)
  }

  private defaultAccess(target: ConfigurationTarget): Promise<boolean> {
    return target.kind === 'access-default'
      ? this.runAndRefresh(() => this.port.mutateSettings(target.namespace.ns, [{
          op: 'set', path: ['defaultPreset'], value: target.preset,
        }], target.namespace.revision), 'access')
      : Promise.resolve(false)
  }

  private defaultPreset(target: ConfigurationTarget): Promise<boolean> {
    return target.kind === 'preset'
      ? this.runAndRefresh(() => this.port.defaultPreset(target.id), 'presets')
      : Promise.resolve(false)
  }

  private async loadSection(section: ConfigurationSection): Promise<void> {
    switch (section) {
      case 'models': {
        const sessionId = this.current
        if (sessionId === undefined) return
        const result = await this.port.models(sessionId)
        if (sessionId !== this.current || this.disposed) return
        if (result.ok) this.models = result.value
        else this.error = `${result.error.message} (${result.error.code})`
        break
      }
      case 'providers': {
        const providers = await this.port.providerCatalog()
        if (!providers.ok) {
          this.error = `${providers.error.message} (${providers.error.code})`
          break
        }
        this.providers = providers.value
        await this.loadSettings()
        if (this.error !== undefined) break
        const credentials = await this.port.credentials(credentialRefs(this.settings))
        if (credentials.ok) this.credentials = credentials.value
        else this.error = `${credentials.error.message} (${credentials.error.code})`
        break
      }
      case 'access': await this.loadSettings(); break
      case 'presets': {
        const result = await this.port.presets()
        if (result.ok) this.presets = result.value
        else this.error = `${result.error.message} (${result.error.code})`
        break
      }
      case 'settings': await this.loadSettings(); break
      case 'credentials': {
        await this.loadSettings()
        if (this.error !== undefined) return
        const result = await this.port.credentials(credentialRefs(this.settings))
        if (result.ok) this.credentials = result.value
        else this.error = `${result.error.message} (${result.error.code})`
        break
      }
      case 'plugins': await this.loadPluginSettings(); break
      case 'extensions': await this.loadExtensions(); break
      default: {
        const exhaustive: never = section
        return exhaustive
      }
    }
  }

  private async loadExtensions(): Promise<void> {
    const extensions = await this.port.extensions()
    if (!extensions.ok) {
      this.error = `${extensions.error.message} (${extensions.error.code})`
      return
    }
    this.extensions = extensions.value
    const plugins = await this.port.plugins()
    if (plugins.ok) this.plugins = plugins.value
    else this.error = `${plugins.error.message} (${plugins.error.code})`
  }

  private async loadPluginSettings(): Promise<void> {
    await this.loadSettings()
    if (this.error !== undefined) return
    const credentials = await this.port.credentials(credentialRefs(this.settings))
    if (credentials.ok) this.credentials = credentials.value
    else this.error = `${credentials.error.message} (${credentials.error.code})`
  }

  private async loadSettings(): Promise<void> {
    const result = await this.port.settings()
    if (result.ok) {
      this.settings = result.value
      this.applyPreferenceSettings(result.value)
    } else this.error = `${result.error.message} (${result.error.code})`
  }

  private async openPreset(target: ConfigurationTarget): Promise<boolean> {
    if (target.kind !== 'preset') return false
    const result = await this.run(() => this.port.openPreset(target.id))
    if (!result.ok) return false
    this.notice = result.value.opened
      ? 'Preset location opened.'
      : `Preset path: ${sanitizeText(result.value.path ?? 'unavailable')}`
    this.schedulePublish()
    return true
  }

  private projected(): ProjectedConfiguration {
    return projectConfiguration({
      data: {
        credentials: this.credentials,
        extensions: this.extensions,
        discoveredModels: this.discoveredModels,
        models: this.models,
        plugins: this.plugins,
        providers: this.providers,
        presetContents: this.presetContents,
        presets: this.presets,
        settings: this.settings,
        locale: this.locale,
        theme: this.theme,
      },
      list: this.list.getSnapshot(),
      section: this.section,
    })
  }

  private changeLocale(target: ConfigurationTarget, locale: LocaleId): Promise<boolean> {
    if (target.kind !== 'locale') return Promise.resolve(false)
    return this.changePreference(
      target,
      LOCALE_PREFERENCE_FIELD,
      locale,
      () => { this.locale.setLocale(locale) },
    )
  }

  private changeTheme(target: ConfigurationTarget, preference: TuiThemePreference): Promise<boolean> {
    if (target.kind !== 'theme') return Promise.resolve(false)
    return this.changePreference(
      target,
      THEME_PREFERENCE_FIELD,
      preference,
      () => { this.theme.setPreference(preference) },
    )
  }

  private async changePreference(
    target: Extract<ConfigurationTarget, { readonly kind: 'locale' | 'theme' }>,
    field: string,
    value: LocaleId | TuiThemePreference,
    apply: () => void,
  ): Promise<boolean> {
    const result = await this.run(() => this.port.mutateSettings(target.namespace, [{
      op: 'set', path: [field], value,
    }], target.revision))
    if (!result.ok) return false
    apply()
    await this.syncPreferences()
    return true
  }

  private pluginSettingValueText(target: ConfigurationPluginSettingTarget): string {
    switch (target.valueKind) {
      case 'number': return typeof target.value === 'number' ? String(target.value) : ''
      case 'text': return typeof target.value === 'string' ? target.value : ''
      case 'credential': return ''
      default: {
        const exhaustive: never = target
        return exhaustive
      }
    }
  }

  private resetPluginSetting(target: ConfigurationTarget): Promise<boolean> {
    if (target.kind !== 'plugin-setting' || target.valueKind === 'credential' || !target.overridden) {
      return Promise.resolve(false)
    }
    return this.runAndRefresh(() => this.port.mutateSettings(target.namespace, [{
      op: 'unset', path: [target.field],
    }], target.revision), 'plugins')
  }

  private removeExtension(target: ConfigurationTarget): Promise<boolean> {
    return target.kind === 'extension' && target.owned
      ? this.runAndRefresh(() => this.port.removeExtension(target.plugin.agentId, target.plugin.pluginId), 'extensions')
      : Promise.resolve(false)
  }

  private removePreset(target: ConfigurationTarget): Promise<boolean> {
    return target.kind === 'preset' && target.trust === 'user'
      ? this.runAndRefresh(() => this.port.removePreset(target.id), 'presets')
      : Promise.resolve(false)
  }

  private resetSetting(target: ConfigurationTarget): Promise<boolean> {
    return target.kind === 'settings'
      ? this.runAndRefresh(() => this.port.resetSetting(target.namespace, target.revision), 'settings')
      : Promise.resolve(false)
  }

  private runExtension(target: ConfigurationTarget): Promise<boolean> {
    if (target.kind !== 'extension' || !target.owned || target.package.hasClientHalf || !target.package.hasHostHalf) {
      return Promise.resolve(false)
    }
    return this.runAndRefresh(() => this.port.runExtension({
      agentId: target.plugin.agentId,
      mode: target.mode,
      packageId: target.package.packageId,
      pluginId: target.plugin.pluginId,
    }), 'extensions')
  }

  private async run<T>(
    operation: () => Promise<ConfigurationResult<T>>,
    options: { readonly sensitive?: boolean } = {},
  ): Promise<ConfigurationResult<T>> {
    this.busyCount += 1
    this.error = undefined
    this.notice = undefined
    this.schedulePublish()
    try {
      const result = await operation()
      if (!result.ok) {
        const message = options.sensitive === true ? 'Credential update failed.' : result.error.message
        this.error = sanitizeText(`${message} (${result.error.code})`)
      }
      return result
    } catch (error) {
      const message = options.sensitive === true ? 'Credential transport failed.' : errorText(error)
      this.error = message
      return { ok: false, error: { code: 'transport', message } }
    } finally {
      this.busyCount -= 1
      this.schedulePublish()
    }
  }

  private async runAndRefresh(
    operation: () => Promise<ConfigurationResult<unknown>>,
    section: ConfigurationSection,
    options: { readonly sensitive?: boolean } = {},
  ): Promise<boolean> {
    const result = await this.run(operation, options)
    if (!result.ok) return false
    if (this.section === section) await this.refresh()
    return true
  }

  private async runBoolean(operation: () => Promise<ConfigurationResult<unknown>>): Promise<boolean> {
    return (await this.run(operation)).ok
  }

  private selectAccess(target: ConfigurationTarget): Promise<boolean> {
    const sessionId = this.current
    return target.kind === 'access' && sessionId !== undefined
      ? this.runBoolean(() => this.port.selectAccess(sessionId, target.preset))
      : Promise.resolve(false)
  }

  private selectModel(target: ConfigurationTarget): Promise<boolean> {
    const sessionId = this.current
    return target.kind === 'model' && sessionId !== undefined
      ? this.runAndRefresh(() => this.port.selectModel(sessionId, target.selection), 'models')
      : Promise.resolve(false)
  }

  private selectPreset(target: ConfigurationTarget): Promise<boolean> {
    const sessionId = this.current
    return target.kind === 'preset' && sessionId !== undefined
      ? this.runAndRefresh(() => this.port.selectPreset(sessionId, target.id), 'presets')
      : Promise.resolve(false)
  }

  private schedulePublish(): void {
    if (this.publishPending || this.disposed) return
    this.publishPending = true
    queueMicrotask(() => {
      this.publishPending = false
      if (this.disposed) return
      for (const listener of this.listeners) listener()
    })
  }

  private status(projected: ProjectedConfiguration, rowIndex: number): string {
    if (this.current === undefined && (this.section === 'models' || this.section === 'access' || this.section === 'extensions')) {
      return this.locale.t('settings.status.noSession')
    }
    if (this.busyCount > 0) return this.locale.t('settings.status.waiting')
    if (this.confirmation !== undefined) {
      return this.locale.t('settings.status.confirm', { action: this.confirmation })
    }
    if (this.input !== undefined) return this.locale.t('settings.status.input')
    if (this.notice !== undefined) return this.notice
    if (projected.rows.length === 0) {
      return this.locale.t('settings.status.empty', { section: this.section })
    }
    const row = projected.rows[rowIndex]
    return `${rowIndex + 1}/${projected.rows.length} · ${row?.actions.map(action => action.label).join(' · ') ?? this.locale.t('settings.status.readOnly')}`
  }

  private async submitPluginSettingInput(
    input: ConfigurationInputView,
    target: ConfigurationPluginSettingTarget | undefined,
    currentTarget: ConfigurationTarget | undefined,
  ): Promise<boolean> {
    if (!samePluginSettingIdentity(target, currentTarget)) {
      this.error = PLUGIN_TARGET_STALE_ERROR
      this.schedulePublish()
      return false
    }
    if (target.valueKind === 'credential') {
      const value = this.secretInput.trim()
      this.clearInput()
      this.schedulePublish()
      if (value === '') return true
      return this.runAndRefresh(
        () => this.port.setCredential(target.credentialRef, value),
        'plugins',
        { sensitive: true },
      )
    }

    const plan = pluginSettingPlan(target, input.value)
    if (plan === undefined) {
      this.error = PLUGIN_NUMBER_ERROR
      this.schedulePublish()
      return false
    }
    const unchanged = plan.operation.op === 'unset'
      ? !target.overridden
      : Object.is(target.value, plan.nextValue)
    if (unchanged) {
      this.clearInput()
      this.error = undefined
      this.schedulePublish()
      return true
    }
    const result = await this.run(() => this.port.mutateSettings(
      target.namespace,
      [plan.operation],
      target.revision,
    ))
    if (!result.ok) return false
    this.clearInput()
    this.schedulePublish()
    if (this.section === 'plugins') await this.refresh()
    return true
  }

  private stopExtension(target: ConfigurationTarget): Promise<boolean> {
    return target.kind === 'extension' && target.owned
      ? this.runAndRefresh(() => this.port.stopExtension(target.plugin.agentId, target.plugin.pluginId), 'extensions')
      : Promise.resolve(false)
  }

  private unsetCredential(target: ConfigurationTarget): Promise<boolean> {
    return target.kind === 'credential'
      ? this.runAndRefresh(() => this.port.unsetCredential(target.ref), 'credentials')
      : Promise.resolve(false)
  }

  private async viewPreset(target: ConfigurationTarget): Promise<boolean> {
    if (target.kind !== 'preset') return false
    const result = await this.run(() => this.port.readPreset(target.id))
    if (!result.ok) return false
    this.presetContents.set(target.id, sanitizeConversationText(result.value))
    this.schedulePublish()
    return true
  }
}

export function createSettingsController(options: ConfigurationControllerOptions): ConfigurationController {
  return new SettingsControllerService(options)
}
