import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { defineTuiAction } from '../../contracts/actions.js'
import {
  CONFIGURATION_ACTION_SCOPE,
  type ConfigurationActionView,
  type ConfigurationCredentialView,
  type ConfigurationExtensionPackage,
  type ConfigurationExtensionRow,
  type ConfigurationModels,
  type ConfigurationPluginEntry,
  type ConfigurationPresetCatalog,
  type ConfigurationRowView,
  type ConfigurationSettingsCatalog,
} from './contracts.js'

export const CONFIGURATION_ACTIONS = Object.freeze({
  access: defineTuiAction(CONFIGURATION_ACTION_SCOPE, 'access.select', 'SELECT', 'positive'),
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
  readonly presetContents: ReadonlyMap<string, string>
  readonly presets: ConfigurationPresetCatalog | undefined
  readonly settings: ConfigurationSettingsCatalog | undefined
}

export type ConfigurationTarget =
  | { readonly kind: 'access'; readonly preset: string }
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

export interface ProjectedConfiguration {
  readonly rows: readonly ConfigurationRowView[]
  readonly targets: ReadonlyMap<string, ConfigurationTarget>
}

export interface ConfigurationProjectionContext {
  readonly current: SessionId | undefined
  readonly data: ConfigurationProjectionData
  readonly targets: Map<string, ConfigurationTarget>
}
