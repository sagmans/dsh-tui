import { type BoxRenderable, type CliRenderer } from '@opentui/core'
import type { TuiTheme } from '../../contracts/theme.js'
import type {
  ConfigurationActionId,
  ConfigurationController,
  ConfigurationSection,
} from '../../features/settings/model.js'
import { createCatalogView } from '../catalog/root.js'

const SECTION_LABELS: Readonly<Record<ConfigurationSection, string>> = Object.freeze({
  models: 'MODELS',
  providers: 'PROVIDERS',
  access: 'ACCESS',
  presets: 'PRESETS',
  settings: 'SETTINGS',
  credentials: 'CREDS',
  plugins: 'PLUGINS',
  extensions: 'EXT',
})

export function createSettingsView(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: ConfigurationController,
): BoxRenderable {
  return createCatalogView<ConfigurationActionId, ConfigurationSection>(renderer, theme, controller, {
    emptyCopy: 'No configuration data.',
    idPrefix: 'settings',
    sectionLabels: SECTION_LABELS,
    title: 'CONFIGURATION',
  })
}
