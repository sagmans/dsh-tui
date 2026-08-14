import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { defineTuiAction } from '../../contracts/actions.js'
import type { TuiTheme } from '../../contracts/theme.js'
import type { TuiLocale } from '../../services/locale.js'
import {
  CONFIGURATION_ACTION_SCOPE,
  type ConfigurationActionView,
  type ConfigurationCredentialView,
  type ConfigurationExtensionPackage,
  type ConfigurationExtensionRow,
  type ConfigurationModels,
  type ConfigurationPluginEntry,
  type ConfigurationPresetCatalog,
  type ConfigurationProviderEntry,
  type ConfigurationProviderModel,
  type ConfigurationDiscoveredModel,
  type ConfigurationRowView,
  type ConfigurationSettingsCatalog,
} from './contracts.js'

export const CONFIGURATION_ACTIONS = Object.freeze({
  access: defineTuiAction(CONFIGURATION_ACTION_SCOPE, 'access.select', 'SELECT', 'positive'),
  accessDefault: defineTuiAction(CONFIGURATION_ACTION_SCOPE, 'access.default', 'MAKE DEFAULT', 'positive'),
  providerCreate: defineTuiAction(CONFIGURATION_ACTION_SCOPE, 'provider.create', 'CREATE', 'positive'),
  providerEdit: defineTuiAction(CONFIGURATION_ACTION_SCOPE, 'provider.edit', 'EDIT', 'default'),
  providerDiscover: defineTuiAction(CONFIGURATION_ACTION_SCOPE, 'provider.discover', 'FETCH MODELS', 'default'),
  providerRemove: defineTuiAction(CONFIGURATION_ACTION_SCOPE, 'provider.remove', 'REMOVE', 'danger'),
  providerCredential: defineTuiAction(CONFIGURATION_ACTION_SCOPE, 'provider.credential', 'SET KEY', 'default'),
  providerModelAdd: defineTuiAction(CONFIGURATION_ACTION_SCOPE, 'provider.model.add', 'ADD MODEL', 'positive'),
  providerModelEdit: defineTuiAction(CONFIGURATION_ACTION_SCOPE, 'provider.model.edit', 'EDIT', 'default'),
  providerModelRemove: defineTuiAction(CONFIGURATION_ACTION_SCOPE, 'provider.model.remove', 'REMOVE', 'danger'),
  providerModelAdopt: defineTuiAction(CONFIGURATION_ACTION_SCOPE, 'provider.model.adopt', 'ADD', 'positive'),
  credentialSet: defineTuiAction(CONFIGURATION_ACTION_SCOPE, 'credential.set', 'SET', 'default'),
  credentialUnset: defineTuiAction(CONFIGURATION_ACTION_SCOPE, 'credential.unset', 'UNSET', 'danger'),
  extensionRemove: defineTuiAction(CONFIGURATION_ACTION_SCOPE, 'extension.remove', 'REMOVE', 'danger'),
  extensionRun: defineTuiAction(CONFIGURATION_ACTION_SCOPE, 'extension.run', 'RUN', 'positive'),
  extensionStop: defineTuiAction(CONFIGURATION_ACTION_SCOPE, 'extension.stop', 'STOP', 'danger'),
  model: defineTuiAction(CONFIGURATION_ACTION_SCOPE, 'model.select', 'SELECT', 'positive'),
  presetCopy: defineTuiAction(CONFIGURATION_ACTION_SCOPE, 'preset.copy', 'COPY', 'default'),
  presetDefault: defineTuiAction(CONFIGURATION_ACTION_SCOPE, 'preset.default', 'DEFAULT', 'positive'),
  presetOpen: defineTuiAction(CONFIGURATION_ACTION_SCOPE, 'preset.open', 'OPEN', 'default'),
  presetRemove: defineTuiAction(CONFIGURATION_ACTION_SCOPE, 'preset.remove', 'REMOVE', 'danger'),
  presetSelect: defineTuiAction(CONFIGURATION_ACTION_SCOPE, 'preset.select', 'SELECT', 'positive'),
  presetView: defineTuiAction(CONFIGURATION_ACTION_SCOPE, 'preset.view', 'VIEW', 'default'),
  settingsOpen: defineTuiAction(CONFIGURATION_ACTION_SCOPE, 'settings.open', 'OPEN FILE', 'default'),
  settingsReset: defineTuiAction(CONFIGURATION_ACTION_SCOPE, 'settings.reset', 'RESET', 'danger'),
} as const satisfies Readonly<Record<string, ConfigurationActionView>>)

export interface ConfigurationProjectionData {
  readonly credentials: Readonly<Record<string, ConfigurationCredentialView>> | undefined
  readonly extensions: readonly ConfigurationExtensionRow[] | undefined
  readonly models: ConfigurationModels | undefined
  readonly plugins: readonly ConfigurationPluginEntry[] | undefined
  readonly providers: readonly ConfigurationProviderEntry[] | undefined
  readonly discoveredModels: ReadonlyMap<string, readonly ConfigurationDiscoveredModel[]>
  readonly presetContents: ReadonlyMap<string, string>
  readonly presets: ConfigurationPresetCatalog | undefined
  readonly settings: ConfigurationSettingsCatalog | undefined
  readonly locale: TuiLocale
  readonly theme: TuiTheme
}

export interface ConfigurationProviderTarget {
  readonly credential: ConfigurationCredentialView | undefined
  readonly credentialRef: string | undefined
  readonly entry: ConfigurationProviderEntry
  readonly kind: 'provider'
  readonly namespace: ConfigurationSettingsCatalog['namespaces'][number]
  readonly profile: Readonly<Record<string, unknown>> | undefined
  readonly removable: boolean
}

export type ConfigurationTarget =
  | { readonly kind: 'access'; readonly preset: string }
  | {
    readonly kind: 'access-default'
    readonly namespace: ConfigurationSettingsCatalog['namespaces'][number]
    readonly preset: string
  }
  | { readonly kind: 'provider-create'; readonly namespace: ConfigurationSettingsCatalog['namespaces'][number] }
  | ConfigurationProviderTarget
  | {
    readonly candidate: ConfigurationDiscoveredModel
    readonly kind: 'provider-candidate'
    readonly provider: ConfigurationProviderTarget
  }
  | {
    readonly index: number
    readonly kind: 'provider-model'
    readonly model: ConfigurationProviderModel
    readonly provider: ConfigurationProviderTarget
  }
  | { readonly kind: 'credential'; readonly ref: string }
  | {
    readonly kind: 'extension'
    readonly mode: 'run' | 'update'
    readonly owned: boolean
    readonly package: ConfigurationExtensionPackage
    readonly plugin: ConfigurationExtensionRow
  }
  | { readonly kind: 'model'; readonly selection: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string } }
  | { readonly kind: 'plugin' }
  | { readonly kind: 'preset'; readonly id: string; readonly trust: 'system' | 'user' }
  | { readonly kind: 'settings'; readonly namespace: string; readonly revision: number }
  | { readonly kind: 'theme'; readonly namespace: string; readonly revision: number }
  | { readonly kind: 'locale'; readonly namespace: string; readonly revision: number }

export interface ProjectedConfiguration {
  readonly rows: readonly ConfigurationRowView[]
  readonly targets: ReadonlyMap<string, ConfigurationTarget>
}

export interface ConfigurationProjectionContext {
  readonly current: SessionId | undefined
  readonly data: ConfigurationProjectionData
  readonly targets: Map<string, ConfigurationTarget>
}
