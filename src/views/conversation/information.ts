import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type Renderable,
} from '@opentui/core'
import type { TuiTheme } from '../../contracts/theme.js'
import type {
  ConversationController,
  ConversationInformationSection,
  ConversationSnapshotView,
} from '../../features/conversation/model.js'
import { createFocusableAction } from '../action.js'
import {
  conversationContextSeat,
  conversationInformationDetails,
  conversationStatisticsSeat,
  conversationWorkSeat,
} from './information-details.js'

const DOCK_ID = 'conversation-information-dock'
const DOCK_HEIGHT = 1
const STATISTICS_SEAT_ID = 'conversation-information-statistics'
const CONTEXT_SEAT_ID = 'conversation-information-context'
const WORK_SEAT_ID = 'conversation-information-work'
const OVERLAY_ID = 'conversation-information-overlay'
const OVERLAY_TITLE = 'CONVERSATION INFO'
const OVERLAY_WIDTH = '88%'
const OVERLAY_HEIGHT = '72%'
const OVERLAY_LEFT = '6%'
const OVERLAY_TOP = '12%'
const OVERLAY_Z_INDEX = 220
const ACTION_HEIGHT = 1
const DETAILS_ID = 'conversation-information-details'
const OVERLAY_ACTIONS_ID = 'conversation-information-actions'
const CLOSE_ACTION_ID = 'conversation-information-close'
const COMPACT_ACTION_ID = 'conversation-information-compact'
const PLAN_OFF_ACTION_ID = 'conversation-information-plan-off'
const CLOSE_LABEL = ' CLOSE '
const COMPACT_LABEL = ' COMPACT '
const PLAN_OFF_LABEL = ' EXIT PLAN '
const ESCAPE_KEY = 'escape'
const STATISTICS_TAB_LABEL = ' STATS '
const CONTEXT_TAB_LABEL = ' CONTEXT '
const WORK_TAB_LABEL = ' WORK '
const TAB_IDS: Readonly<Record<ConversationInformationSection, string>> = Object.freeze({
  context: 'conversation-information-tab-context',
  statistics: 'conversation-information-tab-statistics',
  work: 'conversation-information-tab-work',
})
const TAB_LABELS: Readonly<Record<ConversationInformationSection, string>> = Object.freeze({
  context: CONTEXT_TAB_LABEL,
  statistics: STATISTICS_TAB_LABEL,
  work: WORK_TAB_LABEL,
})
const TAB_SECTIONS = Object.freeze([
  'statistics',
  'context',
  'work',
] as const satisfies readonly ConversationInformationSection[])
interface ActionDefinition {
  readonly content: string
  readonly enabled?: boolean
  readonly id: string
  readonly run: () => void
}

function adjacentAction(
  definitions: readonly ActionDefinition[],
  nodes: readonly Renderable[],
  index: number,
  delta: -1 | 1,
): Renderable | undefined {
  for (let step = 1; step <= definitions.length; step++) {
    const candidate = (index + delta * step + definitions.length) % definitions.length
    if (definitions[candidate]?.enabled !== false) return nodes[candidate]
  }
  return undefined
}

function actionsRow(
  renderer: CliRenderer,
  theme: TuiTheme,
  id: string,
  definitions: readonly ActionDefinition[],
  closeOnEscape?: () => void,
): { readonly root: BoxRenderable; readonly nodes: readonly Renderable[] } {
  const root = new BoxRenderable(renderer, {
    id,
    width: '100%',
    height: ACTION_HEIGHT,
    flexDirection: 'row',
  })
  const nodes: Renderable[] = []
  definitions.forEach((definition, index) => {
    const handleKey = closeOnEscape === undefined
      ? undefined
      : (key: KeyEvent): boolean => {
          if (key.name !== ESCAPE_KEY) return false
          closeOnEscape()
          return true
        }
    const action = createFocusableAction(renderer, {
      content: definition.content,
      ...definition.enabled === undefined ? {} : { enabled: definition.enabled },
      fg: theme.colors.focus,
      ...handleKey === undefined ? {} : { handleKey },
      height: ACTION_HEIGHT,
      id: definition.id,
      mutedFg: theme.colors.muted,
      nextFocus: () => adjacentAction(definitions, nodes, index, 1),
      previousFocus: () => adjacentAction(definitions, nodes, index, -1),
      run: definition.run,
    })
    nodes.push(action)
    root.add(action)
  })
  return { root, nodes }
}

export function createConversationInformationDock(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: ConversationController,
  snapshot: ConversationSnapshotView,
): BoxRenderable | undefined {
  const statistics = conversationStatisticsSeat(snapshot)
  const context = conversationContextSeat(snapshot)
  const work = conversationWorkSeat(snapshot)
  const definitions: ActionDefinition[] = []
  if (statistics !== undefined) {
    definitions.push({
      content: statistics,
      id: STATISTICS_SEAT_ID,
      run: () => { controller.openInformation('statistics') },
    })
  }
  if (context !== undefined) {
    definitions.push({
      content: context,
      id: CONTEXT_SEAT_ID,
      run: () => { controller.openInformation('context') },
    })
  }
  if (work !== undefined) {
    definitions.push({
      content: work,
      id: WORK_SEAT_ID,
      run: () => { controller.openInformation('work') },
    })
  }
  if (definitions.length === 0) return undefined
  const dock = actionsRow(renderer, theme, DOCK_ID, definitions).root
  dock.height = DOCK_HEIGHT
  return dock
}

function informationOverlay(renderer: CliRenderer, theme: TuiTheme): BoxRenderable {
  return new BoxRenderable(renderer, {
    id: OVERLAY_ID,
    title: OVERLAY_TITLE,
    position: 'absolute',
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    left: OVERLAY_LEFT,
    top: OVERLAY_TOP,
    zIndex: OVERLAY_Z_INDEX,
    border: true,
    borderStyle: 'rounded',
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.background,
    paddingX: 1,
    paddingY: 1,
    flexDirection: 'column',
  })
}

function overlayDefinitions(
  controller: ConversationController,
  snapshot: ConversationSnapshotView,
  section: ConversationInformationSection,
): ActionDefinition[] {
  const definitions: ActionDefinition[] = TAB_SECTIONS.map(candidate => ({
    content: TAB_LABELS[candidate],
    id: TAB_IDS[candidate],
    run: () => { controller.openInformation(candidate) },
  }))
  if (section === 'context') definitions.push({
    content: COMPACT_LABEL,
    enabled: snapshot.queueMutable,
    id: COMPACT_ACTION_ID,
    run: () => { void controller.compact() },
  })
  if (section === 'work' && snapshot.plan?.effective === true) definitions.push({
    content: PLAN_OFF_LABEL,
    enabled: snapshot.queueMutable,
    id: PLAN_OFF_ACTION_ID,
    run: () => { void controller.exitPlanMode() },
  })
  definitions.push({ content: CLOSE_LABEL, id: CLOSE_ACTION_ID, run: () => { controller.closeInformation() } })
  return definitions
}

function informationDetails(
  renderer: CliRenderer,
  theme: TuiTheme,
  snapshot: ConversationSnapshotView,
  section: ConversationInformationSection,
): ScrollBoxRenderable {
  const details = new ScrollBoxRenderable(renderer, {
    id: DETAILS_ID,
    flexGrow: 1,
    width: '100%',
    scrollY: true,
    scrollX: false,
  })
  details.add(new TextRenderable(renderer, {
    content: conversationInformationDetails(snapshot, section),
    fg: theme.colors.text,
    selectable: true,
    wrapMode: 'word',
  }))
  return details
}

export function createConversationInformation(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: ConversationController,
  snapshot: ConversationSnapshotView,
): BoxRenderable | undefined {
  const section = snapshot.informationSection
  if (section === undefined) return undefined
  const overlay = informationOverlay(renderer, theme)
  const actionStrip = actionsRow(
    renderer,
    theme,
    OVERLAY_ACTIONS_ID,
    overlayDefinitions(controller, snapshot, section),
    () => { controller.closeInformation() },
  )
  overlay.add(actionStrip.root)
  overlay.add(informationDetails(renderer, theme, snapshot, section))
  const selected = actionStrip.nodes[TAB_SECTIONS.indexOf(section)]
  queueMicrotask(() => { if (selected !== undefined && !selected.isDestroyed) selected.focus() })
  return overlay
}
