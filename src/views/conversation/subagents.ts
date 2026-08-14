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
  ConversationSnapshotView,
  ConversationSubagentRowView,
} from '../../features/conversation/model.js'
import { createFocusableAction } from '../action.js'

const OVERLAY_Z_INDEX = 300
const OVERLAY_PADDING = 1
const HEADER_HEIGHT = 1
const ROW_HEIGHT = 1
const INDENT_WIDTH = 2
const DISCLOSURE_WIDTH = 2
const TRIGGER_ID = 'conversation-subagents'
const OVERLAY_ID = 'conversation-subagents-overlay'
const CLOSE_ID = 'conversation-subagents-close'
const REFRESH_ID = 'conversation-subagents-refresh'
const ROW_ID_PREFIX = 'conversation-subagent-row-'
const TOGGLE_ID_PREFIX = 'conversation-subagent-toggle-'
const ESCAPE_KEY = 'escape'
const UP_KEY = 'up'
const DOWN_KEY = 'down'
const LEFT_KEY = 'left'
const RIGHT_KEY = 'right'
const HOME_KEY = 'home'
const END_KEY = 'end'
const REFRESH_KEY = 'r'
const QUIT_KEY = 'q'
const UP_VIM_KEY = 'k'
const DOWN_VIM_KEY = 'j'
const LEFT_VIM_KEY = 'h'
const RIGHT_VIM_KEY = 'l'
const COLLAPSED_MARKER = '›'
const EXPANDED_MARKER = '⌄'
const LEAF_MARKER = '·'
const RUNNING_MARKER = '●'
const INACTIVE_MARKER = '○'
const ERROR_MARKER = '!'
const LOADING_MARKER = '…'
const DIAGNOSTIC_MARKER = '×'
const CLOSE_LABEL = '[CLOSE]'
const REFRESH_LABEL = '[REFRESH]'
const TITLE = 'AGENTS'
const HINT = '↑↓/jk move · ←→/hl branch · Enter open · r refresh · Esc close'

function marker(row: ConversationSubagentRowView): string {
  switch (row.kind) {
    case 'child': return row.activity === 'running' ? RUNNING_MARKER : INACTIVE_MARKER
    case 'diagnostic': return DIAGNOSTIC_MARKER
    case 'error': return ERROR_MARKER
    case 'loading': return LOADING_MARKER
    default: {
      const exhaustive: never = row.kind
      return exhaustive
    }
  }
}

function disclosure(row: ConversationSubagentRowView): string {
  if (row.kind !== 'child' || row.hasChildren !== true) return LEAF_MARKER
  return row.expanded === true ? EXPANDED_MARKER : COLLAPSED_MARKER
}

function rowContent(row: ConversationSubagentRowView): string {
  return `${marker(row)} ${row.label}${row.summary === '' ? '' : ` · ${row.summary}`}`
}

function enabledRows(snapshot: ConversationSnapshotView): readonly ConversationSubagentRowView[] {
  return snapshot.subagents?.rows.filter(row => row.enabled && row.kind === 'child') ?? []
}

function selectEdge(
  controller: ConversationController,
  snapshot: ConversationSnapshotView,
  edge: 'first' | 'last',
): void {
  const rows = enabledRows(snapshot)
  const row = edge === 'first' ? rows[0] : rows.at(-1)
  if (row !== undefined) controller.selectSubagent(row.key)
}

function handleRowKey(
  key: KeyEvent,
  controller: ConversationController,
  snapshot: ConversationSnapshotView,
  row: ConversationSubagentRowView,
): boolean {
  if (key.name === ESCAPE_KEY || key.name === QUIT_KEY) controller.closeSubagents()
  else if (key.name === UP_KEY || key.name === UP_VIM_KEY) controller.moveSubagent(-1)
  else if (key.name === DOWN_KEY || key.name === DOWN_VIM_KEY) controller.moveSubagent(1)
  else if (key.name === HOME_KEY) selectEdge(controller, snapshot, 'first')
  else if (key.name === END_KEY) selectEdge(controller, snapshot, 'last')
  else if (key.name === REFRESH_KEY) void controller.refreshSubagents(row.parentSessionId)
  else if ((key.name === LEFT_KEY || key.name === LEFT_VIM_KEY) && row.expanded === true) {
    controller.toggleSubagentBranch(row.key)
  } else if ((key.name === RIGHT_KEY || key.name === RIGHT_VIM_KEY)
    && row.kind === 'child' && row.hasChildren === true && row.expanded !== true) {
    controller.toggleSubagentBranch(row.key)
  } else return false
  return true
}

export function createSubagentHeaderTrigger(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: ConversationController,
  snapshot: ConversationSnapshotView,
): TextRenderable | undefined {
  const state = snapshot.subagents
  if (state === undefined) return undefined
  const count = state.runningCount > 0
    ? `${String(state.runningCount)}/${String(state.count)}`
    : String(state.count)
  return createFocusableAction(renderer, {
    content: ` ${state.runningCount > 0 ? RUNNING_MARKER : INACTIVE_MARKER} ${TITLE} ${count} ${state.open ? EXPANDED_MARKER : COLLAPSED_MARKER} `,
    fg: state.runningCount > 0 ? theme.colors.warning : theme.colors.focus,
    height: HEADER_HEIGHT,
    id: TRIGGER_ID,
    mutedFg: theme.colors.muted,
    run: () => { controller.toggleSubagents() },
  })
}

function rowColor(theme: TuiTheme, row: ConversationSubagentRowView): string {
  if (row.kind === 'error') return theme.colors.danger
  if (row.active) return theme.colors.focus
  return row.activity === 'running' ? theme.colors.warning : theme.colors.text
}

function createRow(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: ConversationController,
  snapshot: ConversationSnapshotView,
  row: ConversationSubagentRowView,
): BoxRenderable {
  const root = new BoxRenderable(renderer, {
    id: `${ROW_ID_PREFIX}${row.key}-frame`,
    width: '100%',
    height: ROW_HEIGHT,
    flexDirection: 'row',
    paddingLeft: row.depth * INDENT_WIDTH,
  })
  const canToggle = row.kind === 'child' && row.hasChildren === true
  const toggle = createFocusableAction(renderer, {
    content: disclosure(row),
    enabled: canToggle,
    fg: theme.colors.focus,
    height: ROW_HEIGHT,
    id: `${TOGGLE_ID_PREFIX}${row.key}`,
    mutedFg: theme.colors.muted,
    nextFocus: () => action,
    run: () => {
      controller.selectSubagent(row.key)
      controller.toggleSubagentBranch(row.key)
    },
    width: DISCLOSURE_WIDTH,
  })
  const action = createFocusableAction(renderer, {
    content: rowContent(row),
    enabled: row.enabled,
    fg: rowColor(theme, row),
    handleKey: key => handleRowKey(key, controller, snapshot, row),
    height: ROW_HEIGHT,
    id: `${ROW_ID_PREFIX}${row.key}`,
    mutedFg: theme.colors.muted,
    previousFocus: () => canToggle ? toggle : undefined,
    run: () => {
      controller.selectSubagent(row.key)
      if (row.kind === 'error') void controller.refreshSubagents(row.parentSessionId)
      else controller.activateSubagent()
    },
    width: 'auto',
  })
  root.add(toggle)
  root.add(action)
  return root
}

interface SubagentRows {
  readonly actions: ReadonlyMap<string, Renderable>
  readonly root: ScrollBoxRenderable
}

function createControls(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: ConversationController,
): { readonly close: TextRenderable; readonly root: BoxRenderable } {
  const root = new BoxRenderable(renderer, {
    id: 'conversation-subagents-controls',
    width: '100%',
    height: HEADER_HEIGHT,
    flexDirection: 'row',
  })
  const close = createFocusableAction(renderer, {
    content: CLOSE_LABEL,
    fg: theme.colors.focus,
    handleKey(key) {
      if (key.name === REFRESH_KEY) void controller.refreshSubagents()
      else if (key.name === ESCAPE_KEY || key.name === QUIT_KEY) controller.closeSubagents()
      else return false
      return true
    },
    height: HEADER_HEIGHT,
    id: CLOSE_ID,
    mutedFg: theme.colors.muted,
    run: () => { controller.closeSubagents() },
  })
  root.add(close)
  root.add(createFocusableAction(renderer, {
    content: REFRESH_LABEL,
    fg: theme.colors.focus,
    height: HEADER_HEIGHT,
    id: REFRESH_ID,
    mutedFg: theme.colors.muted,
    run: () => { void controller.refreshSubagents() },
  }))
  root.add(new TextRenderable(renderer, {
    content: HINT,
    fg: theme.colors.muted,
    height: HEADER_HEIGHT,
    truncate: true,
    selectable: false,
    flexGrow: 1,
  }))
  return { close, root }
}

function createRows(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: ConversationController,
  snapshot: ConversationSnapshotView,
): SubagentRows {
  const root = new ScrollBoxRenderable(renderer, {
    id: 'conversation-subagents-rows',
    width: '100%',
    flexGrow: 1,
    scrollY: true,
    scrollX: false,
  })
  const actions = new Map<string, Renderable>()
  for (const row of snapshot.subagents?.rows ?? []) {
    const rendered = createRow(renderer, theme, controller, snapshot, row)
    root.add(rendered)
    const action = rendered.findDescendantById(`${ROW_ID_PREFIX}${row.key}`)
    if (action !== undefined) actions.set(row.key, action)
  }
  return { actions, root }
}

export function createSubagentOverlay(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: ConversationController,
  snapshot: ConversationSnapshotView,
): BoxRenderable | undefined {
  const state = snapshot.subagents
  if (state?.open !== true) return undefined
  const overlay = new BoxRenderable(renderer, {
    id: OVERLAY_ID,
    title: `${TITLE} · ${String(state.runningCount)} running · ${String(state.count)} total`,
    position: 'absolute', width: '100%', height: '100%', left: 0, top: 0,
    zIndex: OVERLAY_Z_INDEX,
    border: true, borderStyle: 'rounded', borderColor: theme.colors.accent,
    backgroundColor: theme.colors.background,
    paddingX: OVERLAY_PADDING, paddingY: OVERLAY_PADDING,
    flexDirection: 'column',
  })
  const controls = createControls(renderer, theme, controller)
  const rows = createRows(renderer, theme, controller, snapshot)
  overlay.add(controls.root)
  overlay.add(rows.root)
  queueMicrotask(() => {
    if (overlay.isDestroyed) return
    const target = state.activeRowKey === undefined ? undefined : rows.actions.get(state.activeRowKey)
    if (target === undefined) controls.close.focus()
    else {
      rows.root.scrollChildIntoView(target.id)
      target.focus()
    }
  })
  return overlay
}
