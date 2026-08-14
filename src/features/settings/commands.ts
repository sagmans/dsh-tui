import { tuiActionCommand } from '../../contracts/actions.js'
import type { TuiCommandLayer } from '../../contracts/commands.js'
import {
  CONFIGURATION_ACTION_IDS,
  CONFIGURATION_ACTION_SCOPE,
  type ConfigurationController,
  type ConfigurationSection,
} from './contracts.js'

const SETTINGS_LAYER_ID = 'dsh-tui-settings'
const SETTINGS_PRIORITY = 300
const NEXT_SECTION_BINDINGS = ['l', 'right', 'tab'] as const
const PREVIOUS_SECTION_BINDINGS = ['h', 'left'] as const
const NEXT_ROW_BINDINGS = ['j', 'down', 'ctrl+n'] as const
const PREVIOUS_ROW_BINDINGS = ['k', 'up', 'ctrl+p'] as const
const NEXT_ACTION_BINDINGS = [']'] as const
const PREVIOUS_ACTION_BINDINGS = ['['] as const
const SECTION_BINDINGS = Object.freeze([
  { section: 'models', key: '1' },
  { section: 'providers', key: '2' },
  { section: 'access', key: '3' },
  { section: 'presets', key: '4' },
  { section: 'settings', key: '5' },
  { section: 'credentials', key: '6' },
  { section: 'plugins', key: '7' },
  { section: 'extensions', key: '8' },
] as const satisfies readonly { readonly section: ConfigurationSection; readonly key: string }[])

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
      { name: 'settings.next-action', description: 'Select next configuration action', run: () => { controller.moveAction(1) } },
      { name: 'settings.previous-action', description: 'Select previous configuration action', run: () => { controller.moveAction(-1) } },
      { name: 'settings.primary', description: 'Run selected configuration action', run: () => controller.perform() },
      { name: 'settings.refresh', description: 'Refresh configuration', run: () => controller.refresh() },
      ...CONFIGURATION_ACTION_IDS.map(action => ({
        name: tuiActionCommand(CONFIGURATION_ACTION_SCOPE, action),
        description: `Run ${action} configuration action`,
        run: () => controller.perform(action),
      })),
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
      ...NEXT_ACTION_BINDINGS.map(key => ({ key, command: 'settings.next-action' })),
      ...PREVIOUS_ACTION_BINDINGS.map(key => ({ key, command: 'settings.previous-action' })),
      { key: 'return', command: 'settings.primary' },
      { key: 'r', command: 'settings.refresh' },
      ...SECTION_BINDINGS.map(({ section, key }) => ({ key, command: `settings.section.${section}` })),
    ],
  }
}
