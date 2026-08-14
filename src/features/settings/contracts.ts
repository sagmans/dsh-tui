import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { TuiActionSpec, TuiActionTone } from '../../contracts/actions.js'
import type { TuiNavigationStore } from '../../kernel/navigation.js'

export const CONFIGURATION_ACTION_SCOPE = 'settings.action'
export const CONFIGURATION_ACTION_IDS = Object.freeze([
  'model.select',
  'provider.create',
  'provider.edit',
  'provider.discover',
  'provider.remove',
  'provider.credential',
  'provider.model.add',
  'provider.model.edit',
  'provider.model.remove',
  'provider.model.adopt',
  'access.select',
  'preset.select',
  'preset.default',
  'preset.view',
  'preset.copy',
  'preset.open',
  'preset.remove',
  'settings.open',
  'settings.reset',
  'credential.set',
  'credential.unset',
  'extension.run',
  'extension.stop',
  'extension.remove',
] as const)

export type ConfigurationSection =
  | 'models'
  | 'providers'
  | 'access'
  | 'presets'
  | 'settings'
  | 'credentials'
  | 'plugins'
  | 'extensions'

export type ConfigurationActionId = typeof CONFIGURATION_ACTION_IDS[number]
export type ConfigurationActionTone = TuiActionTone
export type ConfigurationRowState = 'error' | 'idle' | 'running' | 'success' | 'warning'
export type ConfigurationActionView = TuiActionSpec<ConfigurationActionId>

export interface ConfigurationRowView {
  readonly actions: readonly ConfigurationActionView[]
  readonly details: string
  readonly id: string
  readonly state: ConfigurationRowState
  readonly summary: string
  readonly title: string
}

export interface ConfigurationInputView {
  readonly kind: 'credential' | 'preset-copy' | 'provider'
  readonly secret?: boolean | undefined
  readonly title: string
  readonly value: string
}

export interface ConfigurationSnapshotView {
  readonly busy: boolean
  readonly confirmation: ConfigurationActionId | undefined
  readonly error: string | undefined
  readonly input: ConfigurationInputView | undefined
  readonly rowIndex: number
  readonly rows: readonly ConfigurationRowView[]
  readonly section: ConfigurationSection
  readonly selectedActionId: ConfigurationActionId | undefined
  readonly sections: readonly ConfigurationSection[]
  readonly status: string
}

export interface ConfigurationSessionSummary {
  readonly agentPreset?: string | undefined
  readonly blank: boolean
  readonly projectionValues?: Readonly<Record<string, unknown>> | undefined
}

export interface ConfigurationListState {
  readonly byId: Readonly<Record<string, ConfigurationSessionSummary | undefined>>
  readonly current: SessionId | undefined
}

export type ConfigurationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

export interface ConfigurationModelSelection {
  readonly model: string
  readonly provider: string
  readonly reasoningEffort?: string | undefined
}

export interface ConfigurationModelEffort {
  readonly description?: string | undefined
  readonly id: string
  readonly name: string
}

export interface ConfigurationModels {
  readonly current: ConfigurationModelSelection
  readonly failures: readonly {
    readonly id: string
    readonly message: string
    readonly name: string
  }[]
  readonly groups: readonly {
    readonly id: string
    readonly models: readonly {
      readonly description?: string | undefined
      readonly id: string
      readonly name: string
      readonly reasoning?: {
        readonly defaultEffort?: string | undefined
        readonly efforts: readonly ConfigurationModelEffort[]
      } | undefined
    }[]
    readonly name: string
  }[]
  readonly routable: boolean
}

export interface ConfigurationProviderEntry {
  readonly active: boolean
  readonly declared?: boolean | undefined
  readonly displayName: string
  readonly provider: string
  readonly settingsNs: string
  readonly settingsPath: readonly string[]
}

export interface ConfigurationProviderModel extends Readonly<Record<string, unknown>> {
  readonly contextWindow?: number | undefined
  readonly id: string
  readonly maxTokens?: number | undefined
  readonly name?: string | undefined
}

export interface ConfigurationDiscoveredModel {
  readonly contextWindow?: number | undefined
  readonly id: string
  readonly maxTokens?: number | undefined
  readonly name?: string | undefined
}

export interface ConfigurationDiscoverRequest {
  readonly api?: string | undefined
  readonly apiKey?: string | undefined
  readonly baseURL?: string | undefined
  readonly provider?: string | undefined
  readonly settingsNs: string
}

export type ConfigurationSettingsOperation =
  | { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: 'unset'; readonly path: readonly string[] }

export interface ConfigurationPresetCatalog {
  readonly authorable: boolean
  readonly hasDocument: boolean
  readonly presets: readonly {
    readonly broken?: string | undefined
    readonly description?: string | undefined
    readonly id: string
    readonly isDefault: boolean
    readonly name?: string | undefined
    readonly trust: 'system' | 'user'
  }[]
}

export interface ConfigurationSettingsCatalog {
  readonly hasDocument: boolean
  readonly namespaces: readonly {
    readonly applies: 'live' | 'restart'
    readonly base?: unknown
    readonly ns: string
    readonly revision: number
    readonly schema: unknown
    readonly secrets: readonly { readonly path: readonly string[]; readonly set: boolean }[]
    readonly user?: unknown
    readonly value: unknown
  }[]
  readonly writable: boolean
}

export interface ConfigurationCredentialView {
  readonly configured: boolean
  readonly source?: string | undefined
  readonly writable: boolean
}

export interface ConfigurationPluginEntry {
  readonly enabled: boolean
  readonly entryId: string
  readonly fiberPhase: 'active' | 'failed' | 'loading' | 'pending' | 'unloading' | null
  readonly moduleName: string
}

export interface ConfigurationExtensionPackage {
  readonly hasClientHalf: boolean
  readonly hasHostHalf: boolean
  readonly name: string
  readonly packageId: string
  readonly purpose: string
}

export interface ConfigurationExtensionRun {
  readonly error?: { readonly message: string } | undefined
  readonly mode: 'run' | 'update'
  readonly packageId: string
  readonly status:
    | 'awaiting-approval'
    | 'starting-host'
    | 'client-pending'
    | 'running'
    | 'waiting'
    | 'rejected'
    | 'failed'
    | 'cancelled'
    | 'stopped'
}

export interface ConfigurationExtensionRow {
  readonly activeRun?: { readonly packageId: string; readonly pluginRunId: string } | undefined
  readonly agentId: SessionId
  readonly currentPackageId?: string | undefined
  readonly latestRun?: ConfigurationExtensionRun | undefined
  readonly nextPackageId?: string | undefined
  readonly packages: readonly ConfigurationExtensionPackage[]
  readonly pluginId: string
}

export interface ConfigurationExtensionRequest {
  readonly agentId: SessionId
  readonly mode: 'run' | 'update'
  readonly packageId: string
  readonly pluginId: string
}

export interface ConfigurationPort {
  credentials(refs: readonly string[]): Promise<ConfigurationResult<Readonly<Record<string, ConfigurationCredentialView>>>>
  defaultPreset(preset: string): Promise<ConfigurationResult<void>>
  discoverProviderModels(request: ConfigurationDiscoverRequest): Promise<ConfigurationResult<readonly ConfigurationDiscoveredModel[]>>
  extensions(): Promise<ConfigurationResult<readonly ConfigurationExtensionRow[]>>
  models(sessionId: SessionId): Promise<ConfigurationResult<ConfigurationModels>>
  mutateSettings(
    namespace: string,
    operations: readonly ConfigurationSettingsOperation[],
    revision: number,
  ): Promise<ConfigurationResult<void>>
  openPreset(preset: string): Promise<ConfigurationResult<{ readonly opened: boolean; readonly path?: string | undefined }>>
  openSettings(): Promise<ConfigurationResult<void>>
  plugins(): Promise<ConfigurationResult<readonly ConfigurationPluginEntry[]>>
  presets(): Promise<ConfigurationResult<ConfigurationPresetCatalog>>
  providerCatalog(): Promise<ConfigurationResult<readonly ConfigurationProviderEntry[]>>
  readPreset(preset: string): Promise<ConfigurationResult<string>>
  removeExtension(agentId: SessionId, pluginId: string): Promise<ConfigurationResult<void>>
  removePreset(preset: string): Promise<ConfigurationResult<void>>
  resetSetting(namespace: string, revision: number): Promise<ConfigurationResult<void>>
  runExtension(request: ConfigurationExtensionRequest): Promise<ConfigurationResult<void>>
  selectAccess(sessionId: SessionId, preset: string): Promise<ConfigurationResult<void>>
  selectModel(sessionId: SessionId, selection: ConfigurationModelSelection): Promise<ConfigurationResult<void>>
  selectPreset(sessionId: SessionId, preset: string): Promise<ConfigurationResult<void>>
  setCredential(ref: string, value: string): Promise<ConfigurationResult<void>>
  settings(): Promise<ConfigurationResult<ConfigurationSettingsCatalog>>
  stopExtension(agentId: SessionId, pluginId: string): Promise<ConfigurationResult<void>>
  unsetCredential(ref: string): Promise<ConfigurationResult<void>>
  copyPreset(request: {
    readonly from: string
    readonly id: string
    readonly name?: string | undefined
  }): Promise<ConfigurationResult<void>>
}

export interface ConfigurationControllerOptions {
  readonly list: ObservableSnapshot<ConfigurationListState>
  readonly navigation: TuiNavigationStore
  readonly port: ConfigurationPort
}

export interface ConfigurationController {
  activate(): Promise<void>
  cancelInput(): void
  dispose(): void
  getSnapshot(): ConfigurationSnapshotView
  move(delta: number): void
  moveAction(delta: number): void
  moveSection(delta: number): void
  perform(action?: ConfigurationActionId): Promise<boolean>
  refresh(): Promise<void>
  selectRow(index: number): void
  selectSection(section: ConfigurationSection): void
  setInput(value: string): void
  submitInput(): Promise<boolean>
  subscribe(listener: () => void): () => void
}
