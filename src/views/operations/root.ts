import { type BoxRenderable, type CliRenderer } from '@opentui/core'
import type { TuiTheme } from '../../contracts/theme.js'
import type {
  OperationActionId,
  OperationsController,
  OperationsSection,
} from '../../features/operations/model.js'
import { createCatalogView } from '../catalog/root.js'

const SECTION_LABELS: Readonly<Record<OperationsSection, string>> = Object.freeze({
  goal: 'GOAL',
  plan: 'PLAN',
  workflows: 'FLOWS',
  jobs: 'JOBS',
  subagents: 'AGENTS',
  trajectory: 'TRACE',
  feedback: 'FEEDBACK',
})

export function createOperationsView(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: OperationsController,
): BoxRenderable {
  return createCatalogView<OperationActionId, OperationsSection>(renderer, theme, controller, {
    idPrefix: 'operations',
    sectionLabels: SECTION_LABELS,
    title: 'OPERATIONS',
  })
}
