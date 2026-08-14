import { defineTuiAction } from '../../contracts/actions.js'
import type { TuiThemePreference } from '../../contracts/theme.js'
import type { LocaleKey } from '../../locales/en.js'
import { LOCALE_SETTINGS_NAMESPACE, type LocaleId } from '../../services/locale.js'
import { THEME_SETTINGS_NAMESPACE } from '../../services/theme.js'
import { CONFIGURATION_ACTION_SCOPE } from './contracts.js'
import type {
  ConfigurationActionId,
  ConfigurationActionView,
  ConfigurationRowView,
  ConfigurationSettingsCatalog,
} from './contracts.js'
import {
  type ConfigurationProjectionContext,
} from './projection-types.js'

const THEME_ROW_ID = 'preference:theme'
const LOCALE_ROW_ID = 'preference:locale'
const THEME_OPTIONS = Object.freeze([
  { action: 'theme.light', labelKey: 'settings.theme.light', preference: 'light' },
  { action: 'theme.dark', labelKey: 'settings.theme.dark', preference: 'dark' },
  { action: 'theme.system', labelKey: 'settings.theme.system', preference: 'system' },
] as const satisfies readonly {
  readonly action: ConfigurationActionId
  readonly labelKey: LocaleKey
  readonly preference: TuiThemePreference
}[])
const LOCALE_OPTIONS = Object.freeze([
  { action: 'locale.zh', id: 'zh', labelKey: 'settings.locale.zh' },
  { action: 'locale.en', id: 'en', labelKey: 'settings.locale.en' },
] as const satisfies readonly {
  readonly action: ConfigurationActionId
  readonly id: LocaleId
  readonly labelKey: LocaleKey
}[])

type SettingsNamespace = ConfigurationSettingsCatalog['namespaces'][number]

function namespace(
  catalog: ConfigurationSettingsCatalog | undefined,
  id: string,
): SettingsNamespace | undefined {
  return catalog?.namespaces.find(candidate => candidate.ns === id)
}

function action(
  context: ConfigurationProjectionContext,
  id: ConfigurationActionId,
  labelKey: LocaleKey,
  selected: boolean,
): ConfigurationActionView {
  return defineTuiAction(
    CONFIGURATION_ACTION_SCOPE,
    id,
    context.data.locale.t(labelKey),
    selected ? 'positive' : 'default',
  )
}

function themeRow(context: ConfigurationProjectionContext): ConfigurationRowView {
  const locale = context.data.locale
  const snapshot = context.data.theme.getSnapshot()
  const current = THEME_OPTIONS.find(option => option.preference === snapshot.preference) ?? THEME_OPTIONS[2]
  const settings = namespace(context.data.settings, THEME_SETTINGS_NAMESPACE)
  const writable = context.data.settings?.writable === true && settings !== undefined
  if (writable && settings !== undefined) {
    context.targets.set(THEME_ROW_ID, {
      kind: 'theme',
      namespace: settings.ns,
      revision: settings.revision,
    })
  }
  return {
    actions: writable
      ? THEME_OPTIONS.map(option => action(
          context,
          option.action,
          option.labelKey,
          option.preference === snapshot.preference,
        ))
      : [],
    details: locale.t('settings.preference.theme.details'),
    id: THEME_ROW_ID,
    state: writable ? 'success' : 'warning',
    summary: locale.t('settings.preference.theme.summary', { value: locale.t(current.labelKey) }),
    title: locale.t('settings.preference.theme.title'),
  }
}

function localeRow(context: ConfigurationProjectionContext): ConfigurationRowView {
  const locale = context.data.locale
  const snapshot = locale.getSnapshot()
  const current = LOCALE_OPTIONS.find(option => option.id === snapshot.id) ?? LOCALE_OPTIONS[0]
  const settings = namespace(context.data.settings, LOCALE_SETTINGS_NAMESPACE)
  const writable = context.data.settings?.writable === true && settings !== undefined
  if (writable && settings !== undefined) {
    context.targets.set(LOCALE_ROW_ID, {
      kind: 'locale',
      namespace: settings.ns,
      revision: settings.revision,
    })
  }
  return {
    actions: writable
      ? LOCALE_OPTIONS.map(option => action(
          context,
          option.action,
          option.labelKey,
          option.id === snapshot.id,
        ))
      : [],
    details: locale.t('settings.preference.locale.details'),
    id: LOCALE_ROW_ID,
    state: writable ? 'success' : 'warning',
    summary: locale.t('settings.preference.locale.summary', { value: locale.t(current.labelKey) }),
    title: locale.t('settings.preference.locale.title'),
  }
}

export function preferenceRows(context: ConfigurationProjectionContext): readonly ConfigurationRowView[] {
  return [themeRow(context), localeRow(context)]
}
