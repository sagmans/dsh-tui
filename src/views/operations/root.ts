import {
  BoxRenderable,
  MouseButton,
  ScrollBoxRenderable,
  TextareaRenderable,
  TextAttributes,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
} from '@opentui/core'
import type { TuiTheme } from '../../contracts/theme.js'
import type {
  OperationActionView,
  OperationRowState,
  OperationsController,
  OperationsSection,
  OperationsSnapshotView,
} from '../../features/operations/model.js'

const OVERLAY_WIDTH = '94%'
const OVERLAY_HEIGHT = '90%'
const OVERLAY_LEFT = '3%'
const OVERLAY_TOP = '5%'
const OVERLAY_Z_INDEX = 105
const ROW_HEIGHT = 1
const TABS_HEIGHT = 1
const DETAILS_HEIGHT = 5
const STATUS_HEIGHT = 1
const INPUT_HEIGHT = 4
const RETURN_KEY = 'return'
const ESCAPE_KEY = 'escape'
const EMPTY_COPY = 'No data for current session.'
const SECTION_LABELS: Readonly<Record<OperationsSection, string>> = Object.freeze({
  goal: 'GOAL',
  plan: 'PLAN',
  workflows: 'FLOWS',
  jobs: 'JOBS',
  subagents: 'AGENTS',
  trajectory: 'TRACE',
  feedback: 'FEEDBACK',
})
const STATE_LABELS: Readonly<Record<OperationRowState, string>> = Object.freeze({
  error: 'ERR',
  idle: '·',
  running: 'RUN',
  success: 'OK',
  warning: 'WARN',
})

function stateColor(theme: TuiTheme, state: OperationRowState): string {
  switch (state) {
    case 'error': return theme.colors.danger
    case 'running': return theme.colors.warning
    case 'success': return theme.colors.success
    case 'warning': return theme.colors.warning
    case 'idle': return theme.colors.muted
    default: {
      const exhaustive: never = state
      return String(exhaustive)
    }
  }
}

function createTabs(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: OperationsController,
  snapshot: OperationsSnapshotView,
): BoxRenderable {
  const tabs = new BoxRenderable(renderer, {
    id: 'operations-tabs', width: '100%', height: TABS_HEIGHT, flexDirection: 'row', flexShrink: 0,
  })
  for (const section of snapshot.sections) {
    const selected = section === snapshot.section
    tabs.add(new TextRenderable(renderer, {
      id: `operations-tab-${section}`,
      content: ` ${SECTION_LABELS[section]} `,
      fg: selected ? theme.colors.focus : theme.colors.muted,
      attributes: selected ? TextAttributes.BOLD : TextAttributes.DIM,
      selectable: false,
      onMouseUp(event) {
        // OpenTUI publishes equivalent mouse-button values through separate enum declarations.
        // oxlint-disable-next-line typescript/no-unsafe-enum-comparison
        if (event.button !== MouseButton.LEFT || snapshot.busy) return
        event.preventDefault()
        event.stopPropagation()
        controller.selectSection(section)
      },
    }))
  }
  return tabs
}

function createRows(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: OperationsController,
  snapshot: OperationsSnapshotView,
): ScrollBoxRenderable {
  const list = new ScrollBoxRenderable(renderer, {
    id: 'operations-list', width: '100%', flexGrow: 1, scrollY: true, scrollX: false,
  })
  if (snapshot.rows.length === 0) {
    list.add(new TextRenderable(renderer, { content: EMPTY_COPY, fg: theme.colors.muted, selectable: false }))
    return list
  }
  for (const [index, row] of snapshot.rows.entries()) {
    const selected = index === snapshot.rowIndex
    list.add(new TextRenderable(renderer, {
      id: `operations-row-${index}`,
      content: `${selected ? '›' : ' '} ${STATE_LABELS[row.state]} ${row.title} · ${row.summary}`,
      height: ROW_HEIGHT,
      fg: selected ? theme.colors.focus : stateColor(theme, row.state),
      attributes: selected ? TextAttributes.BOLD : TextAttributes.NONE,
      truncate: true,
      selectable: false,
      onMouseUp(event) {
        // OpenTUI publishes equivalent mouse-button values through separate enum declarations.
        // oxlint-disable-next-line typescript/no-unsafe-enum-comparison
        if (event.button !== MouseButton.LEFT || snapshot.busy) return
        event.preventDefault()
        event.stopPropagation()
        controller.selectRow(index)
      },
    }))
  }
  return list
}

function createDetails(
  renderer: CliRenderer,
  theme: TuiTheme,
  snapshot: OperationsSnapshotView,
): BoxRenderable {
  const row = snapshot.rows[snapshot.rowIndex]
  const frame = new BoxRenderable(renderer, {
    id: 'operations-details',
    title: row?.title ?? 'DETAILS',
    width: '100%',
    height: DETAILS_HEIGHT,
    flexShrink: 0,
    border: true,
    borderStyle: 'single',
    borderColor: theme.colors.border,
    paddingX: 1,
  })
  const scroll = new ScrollBoxRenderable(renderer, { width: '100%', height: '100%', scrollY: true, scrollX: false })
  scroll.add(new TextRenderable(renderer, {
    content: row?.details ?? EMPTY_COPY,
    fg: theme.colors.text,
    wrapMode: 'word',
    selectable: true,
  }))
  frame.add(scroll)
  return frame
}

function actionColor(theme: TuiTheme, action: OperationActionView): string {
  switch (action.tone) {
    case 'danger': return theme.colors.danger
    case 'positive': return theme.colors.success
    case 'default': return theme.colors.focus
    default: {
      const exhaustive: never = action.tone
      return String(exhaustive)
    }
  }
}

function createActions(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: OperationsController,
  snapshot: OperationsSnapshotView,
): BoxRenderable {
  const actions = new BoxRenderable(renderer, {
    id: 'operations-actions', width: '100%', height: ROW_HEIGHT, minHeight: ROW_HEIGHT,
    flexDirection: 'row', flexShrink: 0,
  })
  const row = snapshot.rows[snapshot.rowIndex]
  for (const action of row?.actions ?? []) {
    const confirming = snapshot.confirmation === action.id
    actions.add(new TextRenderable(renderer, {
      id: `operations-action-${action.id}`,
      content: ` ${confirming ? 'CONFIRM ' : ''}${action.label} `,
      fg: snapshot.busy ? theme.colors.muted : actionColor(theme, action),
      attributes: snapshot.busy ? TextAttributes.DIM : TextAttributes.BOLD,
      selectable: false,
      onMouseUp(event) {
        // OpenTUI publishes equivalent mouse-button values through separate enum declarations.
        // oxlint-disable-next-line typescript/no-unsafe-enum-comparison
        if (event.button !== MouseButton.LEFT || snapshot.busy) return
        event.preventDefault()
        event.stopPropagation()
        void controller.perform(action.id)
      },
    }))
  }
  actions.add(new TextRenderable(renderer, {
    content: snapshot.error === undefined ? `  ${snapshot.status}` : `  Error: ${snapshot.error}`,
    height: STATUS_HEIGHT,
    fg: snapshot.error === undefined ? theme.colors.muted : theme.colors.danger,
    truncate: true,
    selectable: false,
  }))
  return actions
}

function handleInputKey(key: KeyEvent, editor: TextareaRenderable, controller: OperationsController): void {
  if (key.name === ESCAPE_KEY) {
    key.preventDefault()
    key.stopPropagation()
    editor.blur()
    controller.cancelInput()
    return
  }
  if (key.ctrl && key.name === RETURN_KEY) {
    key.preventDefault()
    key.stopPropagation()
    void controller.submitInput()
  }
}

function createInput(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: OperationsController,
  snapshot: OperationsSnapshotView,
): BoxRenderable | undefined {
  if (snapshot.input === undefined) return undefined
  const frame = new BoxRenderable(renderer, {
    id: 'operations-input-frame', title: snapshot.input.title, width: '100%', height: INPUT_HEIGHT, border: true,
    flexShrink: 0,
  })
  const editor = new TextareaRenderable(renderer, {
    id: 'operations-input',
    width: '100%',
    height: '100%',
    initialValue: snapshot.input.value,
    textColor: theme.colors.text,
    cursorColor: theme.colors.focus,
    focusedTextColor: theme.colors.text,
    focusedBackgroundColor: theme.colors.background,
    wrapMode: 'word',
    onContentChange() { controller.setInput(editor.plainText) },
    onKeyDown(key) { handleInputKey(key, editor, controller) },
  })
  frame.add(editor)
  queueMicrotask(() => {
    if (editor.isDestroyed) return
    editor.cursorOffset = editor.plainText.length
    editor.focus()
  })
  return frame
}

function createFrame(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: OperationsController,
  snapshot: OperationsSnapshotView,
): BoxRenderable {
  const frame = new BoxRenderable(renderer, {
    id: 'operations-frame', title: 'OPERATIONS', position: 'absolute',
    width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT, left: OVERLAY_LEFT, top: OVERLAY_TOP,
    border: true, borderStyle: 'rounded', borderColor: theme.colors.focus,
    backgroundColor: theme.colors.background, paddingX: 2, paddingY: 1,
    flexDirection: 'column', zIndex: OVERLAY_Z_INDEX,
  })
  frame.add(createTabs(renderer, theme, controller, snapshot))
  frame.add(createRows(renderer, theme, controller, snapshot))
  frame.add(createDetails(renderer, theme, snapshot))
  const input = createInput(renderer, theme, controller, snapshot)
  if (input !== undefined) frame.add(input)
  frame.add(createActions(renderer, theme, controller, snapshot))
  return frame
}

export function createOperationsView(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: OperationsController,
): BoxRenderable {
  const root = new BoxRenderable(renderer, {
    id: 'dsh-tui-operations-view', width: '100%', height: '100%', backgroundColor: theme.colors.background,
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
