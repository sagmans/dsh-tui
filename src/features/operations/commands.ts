import { tuiActionCommand } from '../../contracts/actions.js'
import type { TuiCommandLayer } from '../../contracts/commands.js'
import {
  OPERATION_ACTION_IDS,
  OPERATION_ACTION_SCOPE,
  type OperationsController,
  type OperationsSection,
} from './contracts.js'

const OVERLAY_LAYER_ID = 'dsh-tui-operations-overlay'
const OVERLAY_PRIORITY = 450
const NEXT_BINDINGS = ['l', 'right', 'tab'] as const
const PREVIOUS_BINDINGS = ['h', 'left'] as const
const ROW_NEXT_BINDINGS = ['j', 'down'] as const
const ROW_PREVIOUS_BINDINGS = ['k', 'up'] as const
const ACTION_NEXT_BINDINGS = [']'] as const
const ACTION_PREVIOUS_BINDINGS = ['['] as const
const SECTION_BINDINGS = Object.freeze([
  { section: 'goal', key: '1' },
  { section: 'plan', key: '2' },
  { section: 'workflows', key: '3' },
  { section: 'jobs', key: '4' },
  { section: 'subagents', key: '5' },
  { section: 'trajectory', key: '6' },
  { section: 'feedback', key: '7' },
] as const satisfies readonly { readonly section: OperationsSection; readonly key: string }[])

export function operationsOverlayCommands(
  controller: OperationsController,
  active: () => boolean,
): TuiCommandLayer {
  return {
    id: OVERLAY_LAYER_ID,
    priority: OVERLAY_PRIORITY,
    active,
    commands: [
      { name: 'operations.close', description: 'Close operations', run: () => { controller.close() } },
      { name: 'operations.next-section', description: 'Open next operations section', run: () => { controller.moveSection(1) } },
      { name: 'operations.previous-section', description: 'Open previous operations section', run: () => { controller.moveSection(-1) } },
      { name: 'operations.next', description: 'Select next operation', run: () => { controller.move(1) } },
      { name: 'operations.previous', description: 'Select previous operation', run: () => { controller.move(-1) } },
      { name: 'operations.next-action', description: 'Select next operation action', run: () => { controller.moveAction(1) } },
      { name: 'operations.previous-action', description: 'Select previous operation action', run: () => { controller.moveAction(-1) } },
      { name: 'operations.primary', description: 'Run selected operation action', run: () => controller.perform() },
      { name: 'operations.feedback-positive', description: 'Rate selected message useful', run: () => controller.perform('feedback.positive') },
      { name: 'operations.feedback-negative', description: 'Rate selected message not useful', run: () => controller.perform('feedback.negative') },
      ...OPERATION_ACTION_IDS.map(action => ({
        name: tuiActionCommand(OPERATION_ACTION_SCOPE, action),
        description: `Run ${action} operation action`,
        run: () => controller.perform(action),
      })),
      ...SECTION_BINDINGS.map(({ section }) => ({
        name: `operations.section.${section}`,
        description: `Open ${section} operations`,
        run: () => { controller.selectSection(section) },
      })),
    ],
    bindings: [
      { key: 'escape', command: 'operations.close' },
      { key: 'q', command: 'operations.close' },
      ...NEXT_BINDINGS.map(key => ({ key, command: 'operations.next-section' })),
      ...PREVIOUS_BINDINGS.map(key => ({ key, command: 'operations.previous-section' })),
      ...ROW_NEXT_BINDINGS.map(key => ({ key, command: 'operations.next' })),
      ...ROW_PREVIOUS_BINDINGS.map(key => ({ key, command: 'operations.previous' })),
      ...ACTION_NEXT_BINDINGS.map(key => ({ key, command: 'operations.next-action' })),
      ...ACTION_PREVIOUS_BINDINGS.map(key => ({ key, command: 'operations.previous-action' })),
      { key: 'return', command: 'operations.primary' },
      { key: '+', command: 'operations.feedback-positive' },
      { key: '-', command: 'operations.feedback-negative' },
      ...SECTION_BINDINGS.map(({ section, key }) => ({ key, command: `operations.section.${section}` })),
    ],
  }
}
