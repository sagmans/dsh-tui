import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ConfigurationActionId,
  ConfigurationController,
  ConfigurationControllerOptions,
  ConfigurationInputView,
  ConfigurationResult,
  ConfigurationSection,
  ConfigurationSnapshotView,
} from './contracts.js'
import {
  credentialRefs,
  projectConfiguration,
  type ConfigurationProjectionData,
  type ConfigurationTarget,
  type ProjectedConfiguration,
} from './projection.js'
import { sanitizeConversationText } from '../conversation/projection.js'
import { sanitizeText } from '../sessions/projection.js'

export type * from './contracts.js'

const FIRST_INDEX = 0
const FULL_ACCESS_PRESET = 'danger-full-access'
const COPY_SUFFIX = '-copy'
const SECTION_NAMES: readonly ConfigurationSection[] = Object.freeze([
  'models',
  'access',
  'presets',
  'settings',
  'credentials',
  'plugins',
  'extensions',
])
const CONFIRMED_ACTIONS = new Set<ConfigurationActionId>([
  'settings.reset',
  'credential.unset',
  'preset.remove',
  'extension.stop',
  'extension.remove',
])

function errorText(error: unknown): string {
  return sanitizeText(error instanceof Error ? error.message : String(error))
}

class SettingsControllerService implements ConfigurationController {
  private busyCount = 0
  private confirmation: ConfigurationActionId | undefined
  private confirmationToken: string | undefined
  private credentials: ConfigurationProjectionData['credentials']
  private current: SessionId | undefined
  private disposed = false
  private error: string | undefined
  private extensions: ConfigurationProjectionData['extensions']
  private input: ConfigurationInputView | undefined
  private inputTarget: string | undefined
  private readonly listeners = new Set<() => void>()
  private models: ConfigurationProjectionData['models']
  private notice: string | undefined
  private plugins: ConfigurationProjectionData['plugins']
  private readonly port: ConfigurationControllerOptions['port']
  private readonly presetContents = new Map<string, string>()
  private presets: ConfigurationProjectionData['presets']
  private publishPending = false
  private readonly resources: Array<() => void>
  private rowIndex = FIRST_INDEX
  private section: ConfigurationSection = SECTION_NAMES[FIRST_INDEX] ?? 'models'
  private secretInput = ''
  private settings: ConfigurationProjectionData['settings']

  constructor(options: ConfigurationControllerOptions) {
    this.port = options.port
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
    return Object.freeze({
      busy: this.busyCount > 0,
      confirmation: this.confirmation,
      error: this.error,
      input: this.input,
      rowIndex,
      rows: projected.rows,
      section: this.section,
      sections: SECTION_NAMES,
      status: this.status(projected, rowIndex),
    })
  }

  move(delta: number): void {
    const count = this.projected().rows.length
    if (count === 0 || !Number.isFinite(delta) || delta === 0) return
    const direction = delta < 0 ? -1 : 1
    this.rowIndex = (this.rowIndex + direction + count) % count
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
    const selectedAction = action ?? row?.actions[0]?.id
    if (row === undefined || selectedAction === undefined || !row.actions.some(candidate => candidate.id === selectedAction)) {
      return Promise.resolve(false)
    }
    const target = projected.targets.get(row.id)
    if (target === undefined) return Promise.resolve(false)
    const needsConfirmation = CONFIRMED_ACTIONS.has(selectedAction)
      || (selectedAction === 'access.select' && target.kind === 'access' && target.preset === FULL_ACCESS_PRESET)
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
    this.clearConfirmation()
    this.schedulePublish()
  }

  selectSection(section: ConfigurationSection): void {
    if (!SECTION_NAMES.includes(section) || section === this.section) return
    this.section = section
    this.rowIndex = FIRST_INDEX
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
    const row = this.projected().rows[this.rowIndex]
    const target = row === undefined || row.id !== this.inputTarget
      ? undefined
      : this.projected().targets.get(row.id)
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

  private beginCredential(rowId: string, target: ConfigurationTarget): boolean {
    if (target.kind !== 'credential') return false
    this.secretInput = ''
    this.inputTarget = rowId
    this.input = { kind: 'credential', secret: true, title: `Set ${sanitizeText(target.ref)}`, value: '' }
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

  private clearConfirmation(): void {
    this.confirmation = undefined
    this.confirmationToken = undefined
  }

  private clearInput(): void {
    this.input = undefined
    this.inputTarget = undefined
    this.secretInput = ''
  }

  private clearSessionData(): void {
    this.models = undefined
    this.extensions = undefined
    this.credentials = undefined
    this.presetContents.clear()
    this.rowIndex = FIRST_INDEX
    this.clearConfirmation()
    this.clearInput()
  }

  private confirmationIdentity(action: ConfigurationActionId, rowId: string, target: ConfigurationTarget): string {
    const version = target.kind === 'settings'
      ? target.revision
      : target.kind === 'extension'
        ? `${target.plugin.currentPackageId ?? ''}:${target.plugin.latestRun?.packageId ?? ''}:${target.plugin.latestRun?.status ?? ''}`
        : target.kind === 'credential'
          ? this.credentials?.[target.ref]?.configured
          : target.kind === 'access'
            ? target.preset
            : target.kind === 'preset'
              ? target.id
              : undefined
    return JSON.stringify([action, rowId, version])
  }

  private dispatch(action: ConfigurationActionId, rowId: string, target: ConfigurationTarget): Promise<boolean> {
    switch (action) {
      case 'model.select': return this.selectModel(target)
      case 'access.select': return this.selectAccess(target)
      case 'preset.select': return this.selectPreset(target)
      case 'preset.default': return this.defaultPreset(target)
      case 'preset.view': return this.viewPreset(target)
      case 'preset.copy': return Promise.resolve(this.beginPresetCopy(rowId, target))
      case 'preset.open': return this.openPreset(target)
      case 'preset.remove': return this.removePreset(target)
      case 'settings.open': return this.runBoolean(() => this.port.openSettings())
      case 'settings.reset': return this.resetSetting(target)
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
      case 'access': break
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
      case 'plugins': {
        const result = await this.port.plugins()
        if (result.ok) this.plugins = result.value
        else this.error = `${result.error.message} (${result.error.code})`
        break
      }
      case 'extensions': {
        const result = await this.port.extensions()
        if (result.ok) this.extensions = result.value
        else this.error = `${result.error.message} (${result.error.code})`
        break
      }
      default: {
        const exhaustive: never = section
        return exhaustive
      }
    }
  }

  private async loadSettings(): Promise<void> {
    const result = await this.port.settings()
    if (result.ok) this.settings = result.value
    else this.error = `${result.error.message} (${result.error.code})`
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
        models: this.models,
        plugins: this.plugins,
        presetContents: this.presetContents,
        presets: this.presets,
        settings: this.settings,
      },
      list: this.list.getSnapshot(),
      section: this.section,
    })
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
      return 'No active session.'
    }
    if (this.busyCount > 0) return 'Waiting for host…'
    if (this.confirmation !== undefined) return `Press action again to confirm ${this.confirmation}.`
    if (this.input !== undefined) return 'Ctrl+Enter save · Esc cancel'
    if (this.notice !== undefined) return this.notice
    if (projected.rows.length === 0) return `No ${this.section} data.`
    const row = projected.rows[rowIndex]
    return `${rowIndex + 1}/${projected.rows.length} · ${row?.actions.map(action => action.label).join(' · ') ?? 'read only'}`
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
