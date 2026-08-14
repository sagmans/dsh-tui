import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextAttributes,
  TextRenderable,
  type CliRenderer,
} from '@opentui/core'
import type { TuiTheme } from '../../contracts/theme.js'
import type {
  ModelSelectionController,
  ModelSelectionRowView,
  ModelSelectionSnapshotView,
} from '../../features/model-selection/model.js'
import { createFocusableAction } from '../action.js'

const OVERLAY_WIDTH = '78%'
const OVERLAY_HEIGHT = '72%'
const OVERLAY_LEFT = '11%'
const OVERLAY_TOP = '12%'
const OVERLAY_Z_INDEX = 120
const HEADER_HEIGHT = 1
const STATUS_HEIGHT = 1
const ACTION_HEIGHT = 1
const EMPTY_COPY = 'No selectable entries.'
const SELECTED_INDICATOR = '●'
const AVAILABLE_INDICATOR = '○'
const DISABLED_INDICATOR = '!'
const ACTION_WIDTH_PADDING = 2

function rowContent(row: ModelSelectionRowView, active: boolean): string {
  const cursor = active ? '›' : ' '
  const state = row.enabled
    ? row.selected
      ? SELECTED_INDICATOR
      : AVAILABLE_INDICATOR
    : DISABLED_INDICATOR
  return `${cursor} ${state} ${row.title} · ${row.details}`
}

function createRow(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: ModelSelectionController,
  row: ModelSelectionRowView,
  index: number,
  active: boolean,
): TextRenderable {
  return createFocusableAction(renderer, {
    content: rowContent(row, active),
    enabled: row.enabled,
    fg: active ? theme.colors.focus : row.selected ? theme.colors.success : theme.colors.text,
    height: 1,
    id: `model-selection-row-${index}`,
    mutedFg: theme.colors.muted,
    run: () => {
      controller.selectRow(index)
      void controller.activate()
    },
  })
}

function createRows(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: ModelSelectionController,
  snapshot: ModelSelectionSnapshotView,
): ScrollBoxRenderable {
  const rows = new ScrollBoxRenderable(renderer, {
    id: 'model-selection-rows',
    width: '100%',
    flexGrow: 1,
    scrollY: true,
    scrollX: false,
  })
  if (snapshot.rows.length === 0) {
    rows.add(new TextRenderable(renderer, {
      content: EMPTY_COPY,
      fg: theme.colors.muted,
      selectable: false,
    }))
    return rows
  }
  snapshot.rows.forEach((row, index) => {
    rows.add(createRow(renderer, theme, controller, row, index, index === snapshot.rowIndex))
  })
  queueMicrotask(() => {
    if (rows.isDestroyed) return
    const activeRowId = `model-selection-row-${snapshot.rowIndex}`
    rows.scrollChildIntoView(activeRowId)
    rows.findDescendantById(activeRowId)?.focus()
  })
  return rows
}

function action(
  renderer: CliRenderer,
  theme: TuiTheme,
  id: string,
  label: string,
  run: () => void,
): TextRenderable {
  return createFocusableAction(renderer, {
    content: ` ${label} `,
    fg: theme.colors.focus,
    height: ACTION_HEIGHT,
    id,
    mutedFg: theme.colors.muted,
    run,
    width: label.length + ACTION_WIDTH_PADDING,
  })
}

function createActions(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: ModelSelectionController,
): BoxRenderable {
  const actions = new BoxRenderable(renderer, {
    id: 'model-selection-actions',
    width: '100%',
    height: ACTION_HEIGHT,
    flexDirection: 'row',
  })
  actions.add(action(renderer, theme, 'model-selection-back', 'BACK', () => { controller.back() }))
  actions.add(action(renderer, theme, 'model-selection-refresh', 'REFRESH', () => { void controller.refresh() }))
  actions.add(action(renderer, theme, 'model-selection-providers', 'PROVIDERS', () => { controller.openProviders() }))
  actions.add(action(renderer, theme, 'model-selection-close', 'CLOSE', () => { controller.close() }))
  return actions
}

function createFrame(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: ModelSelectionController,
  snapshot: ModelSelectionSnapshotView,
): BoxRenderable {
  const frame = new BoxRenderable(renderer, {
    id: 'model-selection-frame',
    title: `MODEL · ${snapshot.pane.toUpperCase()}`,
    position: 'absolute',
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    left: OVERLAY_LEFT,
    top: OVERLAY_TOP,
    border: true,
    borderStyle: 'rounded',
    borderColor: snapshot.blocked ? theme.colors.danger : theme.colors.focus,
    backgroundColor: theme.colors.background,
    paddingX: 2,
    paddingY: 1,
    flexDirection: 'column',
    zIndex: OVERLAY_Z_INDEX,
  })
  const selection = snapshot.effortLabel === undefined
    ? snapshot.currentLabel
    : `${snapshot.currentLabel} · ${snapshot.effortLabel}`
  frame.add(new TextRenderable(renderer, {
    content: selection,
    height: HEADER_HEIGHT,
    fg: theme.colors.accent,
    attributes: TextAttributes.BOLD,
    truncate: true,
    selectable: false,
  }))
  frame.add(createRows(renderer, theme, controller, snapshot))
  frame.add(new TextRenderable(renderer, {
    content: snapshot.error === undefined ? snapshot.status : `Error: ${snapshot.error}`,
    height: STATUS_HEIGHT,
    fg: snapshot.error !== undefined || snapshot.blocked ? theme.colors.danger : theme.colors.muted,
    truncate: true,
    selectable: false,
  }))
  frame.add(createActions(renderer, theme, controller))
  return frame
}

export function createModelSelectionView(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: ModelSelectionController,
): BoxRenderable {
  const root = new BoxRenderable(renderer, {
    id: 'dsh-tui-model-selection-view',
    width: '100%',
    height: '100%',
    backgroundColor: theme.colors.background,
  })
  let frame = createFrame(renderer, theme, controller, controller.getSnapshot())
  root.add(frame)
  const unsubscribe = controller.subscribe(() => {
    const next = createFrame(renderer, theme, controller, controller.getSnapshot())
    root.remove(frame)
    frame.destroyRecursively()
    frame = next
    root.add(frame)
  })
  root.once('destroyed', unsubscribe)
  return root
}
