import { type BoxRenderable, type CliRenderer } from '@opentui/core'
import type { TuiTheme } from '../../contracts/theme.js'
import type {
  ConfigurationActionId,
  ConfigurationController,
  ConfigurationSection,
} from '../../features/settings/model.js'
import type { LocaleKey } from '../../locales/en.js'
import type { TuiLocale } from '../../services/locale.js'
import { createCatalogView } from '../catalog/root.js'

const SECTION_LABEL_KEYS: Readonly<Record<ConfigurationSection, LocaleKey>> = Object.freeze({
  models: 'settings.section.models',
  providers: 'settings.section.providers',
  access: 'settings.section.access',
  presets: 'settings.section.presets',
  settings: 'settings.section.settings',
  credentials: 'settings.section.credentials',
  plugins: 'settings.section.plugins',
  extensions: 'settings.section.extensions',
})

function sectionLabels(locale: TuiLocale): Readonly<Record<ConfigurationSection, string>> {
  return Object.freeze({
    access: locale.t(SECTION_LABEL_KEYS.access),
    credentials: locale.t(SECTION_LABEL_KEYS.credentials),
    extensions: locale.t(SECTION_LABEL_KEYS.extensions),
    models: locale.t(SECTION_LABEL_KEYS.models),
    plugins: locale.t(SECTION_LABEL_KEYS.plugins),
    presets: locale.t(SECTION_LABEL_KEYS.presets),
    providers: locale.t(SECTION_LABEL_KEYS.providers),
    settings: locale.t(SECTION_LABEL_KEYS.settings),
  })
}

export function createSettingsView(
  renderer: CliRenderer,
  theme: TuiTheme,
  locale: TuiLocale,
  controller: ConfigurationController,
): BoxRenderable {
  return createCatalogView<ConfigurationActionId, ConfigurationSection>(renderer, theme, controller, {
    confirmLabel: locale.t('settings.confirm'),
    detailsTitle: locale.t('settings.details'),
    emptyCopy: locale.t('settings.empty'),
    errorLabel: locale.t('settings.error'),
    idPrefix: 'settings',
    sectionLabels: sectionLabels(locale),
    title: locale.t('settings.title'),
  })
}
