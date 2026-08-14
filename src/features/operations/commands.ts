import type { TuiCommandLayer } from '../../contracts/commands.js'
import type {
  OperationActionId,
  OperationActionTone,
  OperationsController,
  OperationsSection,
} from './contracts.js'

const OVERLAY_LAYER_ID = 'dsh-tui-operations-overlay'
const OVERLAY_PRIORITY = 450
const NEXT_BINDINGS = ['l', 'right', 'tab'] as const
const PREVIOUS_BINDINGS = ['h', 'left'] as const
const ROW_NEXT_BINDINGS = ['j', 'down'] as const
const ROW_PREVIOUS_BINDINGS = ['k', 'up'] as const
const SECTION_BINDINGS = Object.freeze([
  { section: 'goal', key: '1' },
  { section: 'plan', key: '2' },
  { section: 'workflows', key: '3' },
  { section: 'jobs', key: '4' },
  { section: 'subagents', key: '5' },
  { section: 'trajectory', key: '6' },
  { section: 'feedback', key: '7' },
] as const satisfies readonly { readonly section: OperationsSection; readonly key: string }[])

function selectedAction(controller: OperationsController, tone: OperationActionTone): OperationActionId | undefined {
  const snapshot = controller.getSnapshot()
  return snapshot.rows[snapshot.rowIndex]?.actions.find(action => action.tone === tone)?.id
}

function editAction(controller: OperationsController): OperationActionId | undefined {
  const snapshot = controller.getSnapshot()
  const actions = snapshot.rows[snapshot.rowIndex]?.actions ?? []
  return actions.find(action => action.id === 'goal.edit' || action.id === 'feedback.note')?.id
}

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
      { name: 'operations.primary', description: 'Run primary operation', run: () => controller.perform() },
      { name: 'operations.edit', description: 'Edit selected operation', run: () => controller.perform(editAction(controller)) },
      { name: 'operations.positive', description: 'Run positive operation', run: () => controller.perform(selectedAction(controller, 'positive')) },
      { name: 'operations.danger', description: 'Run destructive operation', run: () => controller.perform(selectedAction(controller, 'danger')) },
      { name: 'operations.feedback-positive', description: 'Rate selected message useful', run: () => controller.perform('feedback.positive') },
      { name: 'operations.feedback-negative', description: 'Rate selected message not useful', run: () => controller.perform('feedback.negative') },
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
      { key: 'return', command: 'operations.primary' },
      { key: 'e', command: 'operations.edit' },
      { key: 'y', command: 'operations.positive' },
      { key: 'x', command: 'operations.danger' },
      { key: '+', command: 'operations.feedback-positive' },
      { key: '-', command: 'operations.feedback-negative' },
      ...SECTION_BINDINGS.map(({ section, key }) => ({ key, command: `operations.section.${section}` })),
    ],
  }
}
