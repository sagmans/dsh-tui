import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  MouseButton,
  ScrollBoxRenderable,
  TextAttributes,
  TextRenderable,
  type CliRenderer,
} from '@opentui/core'
import type { TuiTheme } from '../../contracts/theme.js'
import { createInputActions } from '../action.js'
import type {
  SessionsController,
  SessionsInputState,
  SessionsRow,
  SessionsSnapshot,
} from '../../features/sessions/model.js'

const HEADER_HEIGHT = 1
const ROW_HEIGHT = 1
const ACTION_BAR_HEIGHT = 2
const ACTION_HORIZONTAL_PADDING = 1
const INPUT_HEIGHT = 6
const INPUT_WIDTH = '86%'
const INPUT_LEFT = '7%'
const INPUT_TOP = '20%'
const OVERLAY_Z_INDEX = 200
const INDENT = '  '
const ACTIVE_INDICATOR = '›'
const INACTIVE_INDICATOR = ' '
const EXPANDED_INDICATOR = '▾'
const COLLAPSED_INDICATOR = '▸'
const SESSION_INDICATOR = '·'
const RUNNING_INDICATOR = '●'
const PENDING_INDICATOR = '!'
const EMPTY_COPY = 'No sessions. Press n to start one or a to add a workspace.'
const LOADING_COPY = 'Loading sessions…'
const SEARCH_MORE_COPY = 'More matches exist. Refine search.'
const ESCAPE_KEY = 'escape'
const INPUT_ACTION_PREFIX = 'sessions-input'

interface MouseAction {
  readonly label: string
  readonly run: (controller: SessionsController) => void
}

const MOUSE_ACTIONS: readonly MouseAction[] = Object.freeze([
  { label: '[N]NEW', run: controller => { controller.startSession() } },
  { label: '[/]FIND', run: controller => { controller.openInput('search') } },
  { label: '[R]NAME', run: controller => { controller.openInput('rename') } },
  { label: '[F]FORK', run: controller => { void controller.fork() } },
  { label: '[X]ARCH', run: controller => { void controller.archive() } },
  { label: '[C]CLOSE', run: controller => { controller.close() } },
  { label: '[H]HIST', run: controller => { void controller.loadOlder() } },
  { label: '[A]ADD', run: controller => { controller.openInput('create-workspace') } },
  { label: '[DEL]', run: controller => { controller.requestDelete() } },
  { label: '[↑]', run: controller => { void controller.moveSelected(-1) } },
  { label: '[↓]', run: controller => { void controller.moveSelected(1) } },
])

function rowPrefix(row: SessionsRow): string {
  if (row.kind === 'workspace') return row.expanded === true ? EXPANDED_INDICATOR : COLLAPSED_INDICATOR
  if (row.pending) return PENDING_INDICATOR
  if (row.running) return RUNNING_INDICATOR
  return SESSION_INDICATOR
}

function rowContent(row: SessionsRow, active: boolean): string {
  const selection = active ? ACTIVE_INDICATOR : INACTIVE_INDICATOR
  const current = row.selected ? '*' : INACTIVE_INDICATOR
  const indent = INDENT.repeat(row.depth)
  const detail = row.detail === undefined ? '' : `  ${row.detail}`
  return `${selection}${indent}${rowPrefix(row)}${current} ${row.title}${detail}`
}

function createRow(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: SessionsController,
  row: SessionsRow,
  active: boolean,
): TextRenderable {
  return new TextRenderable(renderer, {
    id: `sessions-row-${row.key}`,
    content: rowContent(row, active),
    height: ROW_HEIGHT,
    truncate: true,
    fg: row.pending
      ? theme.colors.warning
      : row.running
        ? theme.colors.success
        : active
          ? theme.colors.focus
          : theme.colors.text,
    attributes: active ? TextAttributes.BOLD : 0,
    selectable: false,
    onMouseUp(event) {
      // OpenTUI publishes equivalent mouse-button values through separate enum declarations.
      // oxlint-disable-next-line typescript/no-unsafe-enum-comparison
      if (event.button !== MouseButton.LEFT) return
      event.preventDefault()
      event.stopPropagation()
      controller.select(row.key)
      controller.activate()
    },
  })
}

function createInput(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: SessionsController,
  state: SessionsInputState,
): BoxRenderable {
  const overlay = new BoxRenderable(renderer, {
    id: 'sessions-input-overlay',
    title: state.title,
    position: 'absolute',
    width: INPUT_WIDTH,
    height: INPUT_HEIGHT,
    left: INPUT_LEFT,
    top: INPUT_TOP,
    zIndex: OVERLAY_Z_INDEX,
    border: true,
    borderStyle: 'rounded',
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.background,
    paddingX: 1,
    paddingY: 1,
  })
  const input = new InputRenderable(renderer, {
    id: 'sessions-input',
    value: state.initialValue,
    placeholder: state.placeholder,
    textColor: theme.colors.text,
    cursorColor: theme.colors.focus,
    focusedTextColor: theme.colors.text,
    focusedBackgroundColor: theme.colors.background,
    onKeyDown(key) {
      if (inputActions.focusForTab(key)) return
      if (key.name !== ESCAPE_KEY) return
      key.preventDefault()
      key.stopPropagation()
      controller.cancel()
    },
  })
  input.on(InputRenderableEvents.ENTER, (value: string) => { void controller.submitInput(value) })
  const inputActions = createInputActions(renderer, theme, {
    cancel: () => { controller.cancel() },
    idPrefix: INPUT_ACTION_PREFIX,
    input,
    save: () => { void controller.submitInput(input.plainText) },
  })
  overlay.add(input)
  overlay.add(inputActions.root)
  queueMicrotask(() => { if (!input.isDestroyed) input.focus() })
  return overlay
}

function createDeleteAction(
  renderer: CliRenderer,
  theme: TuiTheme,
  content: string,
  danger: boolean,
  run: () => void,
): TextRenderable {
  return new TextRenderable(renderer, {
    content,
    width: '50%',
    fg: danger ? theme.colors.danger : theme.colors.focus,
    attributes: TextAttributes.BOLD,
    selectable: false,
    onMouseUp(event) {
      // OpenTUI publishes equivalent mouse-button values through separate enum declarations.
      // oxlint-disable-next-line typescript/no-unsafe-enum-comparison
      if (event.button !== MouseButton.LEFT) return
      event.preventDefault()
      event.stopPropagation()
      run()
    },
  })
}

function createDeleteConfirmation(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: SessionsController,
): BoxRenderable {
  const overlay = new BoxRenderable(renderer, {
    id: 'sessions-delete-confirmation',
    title: 'REMOVE WORKSPACE REGISTRATION?',
    position: 'absolute',
    width: INPUT_WIDTH,
    height: INPUT_HEIGHT,
    left: INPUT_LEFT,
    top: INPUT_TOP,
    zIndex: OVERLAY_Z_INDEX,
    border: true,
    borderStyle: 'rounded',
    borderColor: theme.colors.danger,
    backgroundColor: theme.colors.background,
    paddingX: 1,
    paddingY: 1,
  })
  overlay.add(new TextRenderable(renderer, {
    content: 'Workspace entry only; directory and sessions remain.',
    fg: theme.colors.text,
    selectable: false,
  }))
  const actions = new BoxRenderable(renderer, { width: '100%', flexDirection: 'row' })
  actions.add(createDeleteAction(renderer, theme, '[CANCEL]', false, () => { controller.cancel() }))
  actions.add(createDeleteAction(renderer, theme, '[REMOVE]', true, () => { void controller.confirmDelete() }))
  overlay.add(actions)
  return overlay
}

function createActions(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: SessionsController,
): BoxRenderable {
  const actions = new BoxRenderable(renderer, {
    id: 'sessions-actions',
    width: '100%',
    height: ACTION_BAR_HEIGHT,
    flexDirection: 'row',
    flexWrap: 'wrap',
  })
  for (const action of MOUSE_ACTIONS) {
    actions.add(new TextRenderable(renderer, {
      content: action.label,
      width: action.label.length + ACTION_HORIZONTAL_PADDING,
      fg: theme.colors.muted,
      attributes: TextAttributes.DIM,
      selectable: false,
      onMouseUp(event) {
        // OpenTUI publishes equivalent mouse-button values through separate enum declarations.
        // oxlint-disable-next-line typescript/no-unsafe-enum-comparison
        if (event.button !== MouseButton.LEFT) return
        event.preventDefault()
        event.stopPropagation()
        action.run(controller)
      },
    }))
  }
  return actions
}

function createFrame(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: SessionsController,
  snapshot: SessionsSnapshot,
): BoxRenderable {
  const frame = new BoxRenderable(renderer, {
    id: 'sessions-root',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    backgroundColor: theme.colors.background,
  })
  frame.add(new TextRenderable(renderer, {
    content: snapshot.searchQuery === '' ? 'WORKSPACES / SESSIONS' : `SEARCH  ${snapshot.searchQuery}`,
    height: HEADER_HEIGHT,
    fg: theme.colors.accent,
    attributes: TextAttributes.BOLD,
    selectable: false,
  }))
  const list = new ScrollBoxRenderable(renderer, {
    id: 'sessions-list',
    flexGrow: 1,
    width: '100%',
    scrollY: true,
    scrollX: false,
  })
  if (snapshot.phase === 'loading') {
    list.add(new TextRenderable(renderer, { content: LOADING_COPY, fg: theme.colors.muted, selectable: false }))
  } else if (snapshot.rows.length === 0) {
    list.add(new TextRenderable(renderer, { content: EMPTY_COPY, fg: theme.colors.muted, selectable: false }))
  } else {
    for (const row of snapshot.rows) {
      list.add(createRow(renderer, theme, controller, row, row.key === snapshot.activeRowKey))
    }
  }
  frame.add(list)
  if (snapshot.activeRowKey !== undefined) {
    const activeId = `sessions-row-${snapshot.activeRowKey}`
    queueMicrotask(() => { if (!list.isDestroyed) list.scrollChildIntoView(activeId) })
  }
  if (snapshot.searchHasMore) {
    frame.add(new TextRenderable(renderer, {
      content: SEARCH_MORE_COPY,
      height: ROW_HEIGHT,
      fg: theme.colors.warning,
      truncate: true,
      selectable: false,
    }))
  }
  if (snapshot.error !== undefined) {
    frame.add(new TextRenderable(renderer, {
      content: `Error: ${snapshot.error}`,
      height: ROW_HEIGHT,
      fg: theme.colors.danger,
      truncate: true,
      selectable: false,
    }))
  }
  frame.add(createActions(renderer, theme, controller))
  if (snapshot.input !== undefined) frame.add(createInput(renderer, theme, controller, snapshot.input))
  if (snapshot.confirmDelete) frame.add(createDeleteConfirmation(renderer, theme, controller))
  return frame
}

export function createSessionsView(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: SessionsController,
): BoxRenderable {
  const root = new BoxRenderable(renderer, {
    id: 'dsh-tui-sessions-view',
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
  root.once('destroyed', () => {
    unsubscribe()
    controller.deactivate()
  })
  return root
}
