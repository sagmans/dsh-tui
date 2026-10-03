import type { Context } from '@deepseek-ai/cordis'
import { openSection, type SectionScope } from '../compat/section.ts'
import type { PreferenceHome } from '../theme-command.ts'
import { asRecord } from '../theme-schema.ts'
import { TUI_SETTINGS_NAMESPACE, TuiSettingsSchema, readScope, settingsProblemMessage, type TuiSettings } from '../theme-settings.ts'

const WRITE_UNSUPPORTED = 'the settings service cannot write the section; the patch was not applied'

/** The painter keeps applied state; this owner only coordinates its durable preference source. */
export interface AppearancePreferencePorts {
  readonly rowSettings: () => unknown
  readonly rowSettingsLive: boolean
  readonly applied: () => TuiSettings | undefined
  readonly apply: () => void
  readonly restyle: () => void
  readonly restorePreview: () => void
  readonly disableHistory: () => void
  readonly notice: (message: string) => void
  readonly problem: (message: string) => void
}

/** Preference ownership stays independent of theme files, rendering, and picker state. */
export interface AppearancePreferences {
  readonly read: () => TuiSettings
  readonly configBacked: () => boolean
  /** Where a write lands, so a reader can be told which file to edit. */
  readonly home: () => PreferenceHome
  readonly chooseTheme: (name: string) => void
  readonly allowsHistory: (field: 'enabled' | 'ghost', applied: boolean) => boolean
  readonly register: () => void
  readonly listen: () => () => void
}

/** Keep attachment, persistence, and notifications on the same checked settings source. */
export function createAppearancePreferences(ctx: Context, ports: AppearancePreferencePorts): AppearancePreferences {
  let configBacked = false
  // Unknown until a supported owner answers: no owner means no file worth naming.
  let home: PreferenceHome = { kind: 'unknown' }
  let activeScope: SectionScope | undefined
  // Where descriptors expose raw opt-outs, rejection may leave both revision and notifications unchanged.
  // Keep their veto for that revision so a rejected opt-in cannot resume history.
  let privacyRevision: number | undefined
  let hadUser = false
  let blocked = { enabled: false, ghost: false }
  const observePrivacy = (): void => {
    try {
      const user = activeScope?.readUser()
      if (user === undefined) return
      if (user.revision !== privacyRevision) {
        privacyRevision = user.revision
        hadUser = false
        blocked = { enabled: false, ghost: false }
      }
      // An invalid root is omitted by describe(); valid removal advances the revision.
      if (user.value === undefined && hadUser) blocked = { enabled: true, ghost: true }
      hadUser ||= user.value !== undefined
      const section = asRecord(user.value)
      const history = asRecord(section?.history)
      if ((user.value !== undefined && section === undefined) || (section?.history !== undefined && history === undefined)) {
        blocked = { enabled: true, ghost: true }
      } else {
        if (history?.enabled !== undefined && history.enabled !== true) blocked.enabled = true
        if (history?.ghost !== undefined && history.ghost !== true) blocked.ghost = true
      }
    } catch {
      // Unreadable raw preferences cannot authorize recording or suggestions.
      blocked = { enabled: true, ghost: true }
    }
  }
  let readSection = (): TuiSettings => {
    const row = readScope({ get: ports.rowSettings }, ports.problem)
    // Until a supported owner can read preferences, absence cannot authorize recording.
    return { ...row, history: { ...row.history, enabled: false, ghost: false } }
  }
  // Without a writable owner, leaving the preview would imply a choice that cannot persist.
  let chooseTheme = (_name: string): void => {
    ports.restorePreview()
    ports.problem(WRITE_UNSUPPORTED)
  }
  // Profile settings address local row IDs, not the Loader's qualified entry paths.
  const configNamespace = (ctx.fiber as { entry?: { options: { id?: string } } }).entry?.options.id
  const register = (): void => {
    // Row appearance must exist before prompt memory, even when Cordis defers attachment.
    ports.apply()
    ctx.inject(['settings'], settingsCtx => {
      let scope: SectionScope
      try {
        scope = openSection(settingsCtx.settings, {
          owner: settingsCtx,
          ns: TUI_SETTINGS_NAMESPACE,
          schema: TuiSettingsSchema,
          entry: ports.rowSettings(),
          config: { ns: configNamespace, get: ports.rowSettings, live: ports.rowSettingsLive },
          onChange: () => {
            ports.apply()
            ports.restyle()
          },
        })
      } catch (error) {
        ports.disableHistory()
        ports.problem(settingsProblemMessage(error) + ' · prompt history stays off until the section parses')
        return
      }
      activeScope = scope
      home = scope.kind === 'config'
        ? scope.document === undefined ? { kind: 'unknown' } : { kind: 'document', path: scope.document }
        : scope.kind === 'unsupported' ? { kind: 'unknown' } : { kind: 'section' }
      privacyRevision = undefined
      hadUser = false
      blocked = { enabled: false, ghost: false }
      configBacked = scope.kind === 'config'
      // Give rejected candidates the painter’s last valid appearance and applied privacy opt-outs, not fresh defaults.
      readSection = () => readScope({ get: () => {
        const raw = scope.get()
        if (scope.kind !== 'config') return raw
        const record = asRecord(raw)
        if (record === undefined) return raw
        const history = asRecord(record.history)
        // Legacy import follows Loader activation. Missing switches cannot opt in first.
        if (record.history !== undefined && history === undefined) return raw
        return { ...record, history: {
          ...history,
          enabled: history?.enabled === undefined ? false : history.enabled,
          ghost: history?.ghost === undefined ? false : history.ghost,
        } }
      } }, ports.problem, ports.applied())
      // A preview is not a persisted choice: success requires owner acceptance; rejection must restore the applied appearance.
      chooseTheme = name => {
        void scope.update({ theme: name }).then(
          () => {
            ports.apply()
            ports.restyle()
            ports.notice(`theme · ${name} · written to the settings document`)
          },
          (error: unknown) => {
            ports.restorePreview()
            ports.problem(settingsProblemMessage(error))
          },
        )
      }
      ports.apply()
    })
  }
  const listen = (): (() => void) => {
    const changed = (ns: unknown): void => {
      if (String(ns) !== TUI_SETTINGS_NAMESPACE && String(ns) !== configNamespace) return
      ports.apply()
      ports.restyle()
    }
    // The harness folds a section's committed value into its one document event,
    // so a write made by another surface still reaches the reader without a reload.
    const config = ctx.on('settings/document-updated', changed)
    return () => { config() }
  }
  return {
    read: () => {
      const section = readSection()
      // Attachment and commits must establish raw-layer presence before the first history use.
      observePrivacy()
      return section
    },
    configBacked: () => configBacked,
    home: () => home,
    chooseTheme: name => chooseTheme(name),
    allowsHistory: (field, applied) => {
      // Raw opt-outs may produce no change event, so each history use must consult the veto.
      observePrivacy()
      return applied && !blocked[field]
    },
    register,
    listen,
  }
}
