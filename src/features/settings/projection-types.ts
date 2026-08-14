import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ConfigurationActionView,
  ConfigurationCredentialView,
  ConfigurationExtensionPackage,
  ConfigurationExtensionRow,
  ConfigurationModels,
  ConfigurationPluginEntry,
  ConfigurationPresetCatalog,
  ConfigurationRowView,
  ConfigurationSettingsCatalog,
} from './contracts.js'

export const CONFIGURATION_ACTIONS = Object.freeze({
  access: { id: 'access.select', label: 'SELECT', tone: 'positive' },
  credentialSet: { id: 'credential.set', label: 'SET', tone: 'default' },
  credentialUnset: { id: 'credential.unset', label: 'UNSET', tone: 'danger' },
  extensionRemove: { id: 'extension.remove', label: 'REMOVE', tone: 'danger' },
  extensionRun: { id: 'extension.run', label: 'RUN', tone: 'positive' },
  extensionStop: { id: 'extension.stop', label: 'STOP', tone: 'danger' },
  model: { id: 'model.select', label: 'SELECT', tone: 'positive' },
  presetCopy: { id: 'preset.copy', label: 'COPY', tone: 'default' },
  presetDefault: { id: 'preset.default', label: 'DEFAULT', tone: 'positive' },
  presetOpen: { id: 'preset.open', label: 'OPEN', tone: 'default' },
  presetRemove: { id: 'preset.remove', label: 'REMOVE', tone: 'danger' },
  presetSelect: { id: 'preset.select', label: 'SELECT', tone: 'positive' },
  presetView: { id: 'preset.view', label: 'VIEW', tone: 'default' },
  settingsOpen: { id: 'settings.open', label: 'OPEN FILE', tone: 'default' },
  settingsReset: { id: 'settings.reset', label: 'RESET', tone: 'danger' },
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
