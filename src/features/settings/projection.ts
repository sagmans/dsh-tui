import type {
  ConfigurationListState,
  ConfigurationRowView,
  ConfigurationSection,
} from './contracts.js'
import {
  credentialRows,
  presetRows,
  settingsRows,
} from './projection-configuration.js'
import { extensionRows, pluginRows } from './projection-plugins.js'
import { preferenceRows } from './projection-preferences.js'
import { providerRows } from './projection-providers.js'
import { accessRows, modelRows } from './projection-selections.js'
import type {
  ConfigurationProjectionContext,
  ConfigurationProjectionData,
  ProjectedConfiguration,
} from './projection-types.js'

export { credentialRefs } from './projection-configuration.js'
export type {
  ConfigurationProjectionData,
  ConfigurationProviderTarget,
  ConfigurationTarget,
  ProjectedConfiguration,
} from './projection-types.js'

export function projectConfiguration(input: {
  readonly data: ConfigurationProjectionData
  readonly list: ConfigurationListState
  readonly section: ConfigurationSection
}): ProjectedConfiguration {
  const context: ConfigurationProjectionContext = {
    current: input.list.current,
    data: input.data,
    targets: new Map(),
  }
  let rows: readonly ConfigurationRowView[]
  switch (input.section) {
    case 'models': rows = modelRows(context); break
    case 'providers': rows = providerRows(context); break
    case 'access': rows = accessRows(input.list, context); break
    case 'presets': rows = presetRows(input.list, context); break
    case 'settings': rows = [...settingsRows(context), ...preferenceRows(context)]; break
    case 'credentials': rows = credentialRows(context); break
    case 'plugins': rows = pluginRows(context); break
    case 'extensions': rows = extensionRows(context); break
    default: {
      const exhaustive: never = input.section
      rows = exhaustive
    }
  }
  return { rows: Object.freeze(rows), targets: context.targets }
}
