import type { TuiCommandLayer } from '../../contracts/commands.js'
import type {
  ConfigurationActionId,
  ConfigurationActionTone,
  ConfigurationController,
  ConfigurationSection,
} from './contracts.js'

const SETTINGS_LAYER_ID = 'dsh-tui-settings'
const SETTINGS_PRIORITY = 300
const NEXT_SECTION_BINDINGS = ['l', 'right', 'tab'] as const
const PREVIOUS_SECTION_BINDINGS = ['h', 'left'] as const
const NEXT_ROW_BINDINGS = ['j', 'down', 'ctrl+n'] as const
const PREVIOUS_ROW_BINDINGS = ['k', 'up', 'ctrl+p'] as const
const EDIT_ACTIONS = new Set<ConfigurationActionId>([
  'preset.view',
  'preset.copy',
  'preset.open',
  'settings.open',
  'credential.set',
])
const SECTION_BINDINGS = Object.freeze([
  { section: 'models', key: '1' },
  { section: 'access', key: '2' },
  { section: 'presets', key: '3' },
  { section: 'settings', key: '4' },
  { section: 'credentials', key: '5' },
  { section: 'plugins', key: '6' },
  { section: 'extensions', key: '7' },
] as const satisfies readonly { readonly section: ConfigurationSection; readonly key: string }[])

function selectedAction(
  controller: ConfigurationController,
  predicate: (action: { readonly id: ConfigurationActionId; readonly tone: ConfigurationActionTone }) => boolean,
): ConfigurationActionId | undefined {
  const snapshot = controller.getSnapshot()
  return snapshot.rows[snapshot.rowIndex]?.actions.find(predicate)?.id
}

export function settingsCommands(
  controller: ConfigurationController,
  close: () => void,
  active: () => boolean,
): TuiCommandLayer {
  return {
    id: SETTINGS_LAYER_ID,
    priority: SETTINGS_PRIORITY,
    active,
    commands: [
      { name: 'settings.close', description: 'Return to conversation', run: close },
      { name: 'settings.next-section', description: 'Open next configuration section', run: () => { controller.moveSection(1) } },
      { name: 'settings.previous-section', description: 'Open previous configuration section', run: () => { controller.moveSection(-1) } },
      { name: 'settings.next', description: 'Select next configuration row', run: () => { controller.move(1) } },
      { name: 'settings.previous', description: 'Select previous configuration row', run: () => { controller.move(-1) } },
      { name: 'settings.primary', description: 'Run primary configuration action', run: () => controller.perform() },
      { name: 'settings.edit', description: 'Run edit configuration action', run: () => controller.perform(selectedAction(controller, action => EDIT_ACTIONS.has(action.id))) },
      { name: 'settings.positive', description: 'Run positive configuration action', run: () => controller.perform(selectedAction(controller, action => action.tone === 'positive')) },
      { name: 'settings.danger', description: 'Run destructive configuration action', run: () => controller.perform(selectedAction(controller, action => action.tone === 'danger')) },
      { name: 'settings.refresh', description: 'Refresh configuration', run: () => controller.refresh() },
      ...SECTION_BINDINGS.map(({ section }) => ({
        name: `settings.section.${section}`,
        description: `Open ${section} configuration`,
        run: () => { controller.selectSection(section) },
      })),
    ],
    bindings: [
      { key: 'escape', command: 'settings.close' },
      { key: 'q', command: 'settings.close' },
      ...NEXT_SECTION_BINDINGS.map(key => ({ key, command: 'settings.next-section' })),
      ...PREVIOUS_SECTION_BINDINGS.map(key => ({ key, command: 'settings.previous-section' })),
      ...NEXT_ROW_BINDINGS.map(key => ({ key, command: 'settings.next' })),
      ...PREVIOUS_ROW_BINDINGS.map(key => ({ key, command: 'settings.previous' })),
      { key: 'return', command: 'settings.primary' },
      { key: 'e', command: 'settings.edit' },
      { key: 'y', command: 'settings.positive' },
      { key: 'x', command: 'settings.danger' },
      { key: 'r', command: 'settings.refresh' },
      ...SECTION_BINDINGS.map(({ section, key }) => ({ key, command: `settings.section.${section}` })),
    ],
  }
}
