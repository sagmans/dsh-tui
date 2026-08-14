import {
  BoxRenderable,
  MouseButton,
  ScrollBoxRenderable,
  TextAttributes,
  TextRenderable,
  type CliRenderer,
} from '@opentui/core'
import type { TuiTheme } from '../../contracts/theme.js'
import type {
  ToolInspectorRow,
  ToolsController,
  ToolsSnapshotView,
} from '../../features/tools/model.js'

const HEADER_HEIGHT = 1
const STATUS_HEIGHT = 1
const ROW_HEIGHT = 1
const DETAIL_BORDER_HEIGHT = 7
const TREE_INDENT = '  '
const EMPTY_COPY = 'No tool calls in current history window.'
const TOOL_STATE_LABELS: Readonly<Record<ToolInspectorRow['state'], string>> = Object.freeze({
  error: 'ERR',
  ok: 'OK',
  running: 'RUN',
  stopped: 'STOP',
})

function colorFor(theme: TuiTheme, state: ToolInspectorRow['state']): string {
  switch (state) {
    case 'error': return theme.colors.danger
    case 'ok': return theme.colors.success
    case 'running': return theme.colors.warning
    case 'stopped': return theme.colors.muted
    default: {
      const exhaustive: never = state
      return String(exhaustive)
    }
  }
}

function createToolRow(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: ToolsController,
  snapshot: ToolsSnapshotView,
  row: ToolInspectorRow,
): TextRenderable {
  const selected = row.callId === snapshot.selectedCallId
  const branch = row.expandable ? row.expanded ? '▾' : '▸' : '·'
  return new TextRenderable(renderer, {
    id: `tool-row-${row.callId}`,
    content: `${TREE_INDENT.repeat(row.depth)}${branch} ${TOOL_STATE_LABELS[row.state]} ${row.title} · ${row.summary}`,
    height: ROW_HEIGHT,
    fg: selected ? theme.colors.focus : colorFor(theme, row.state),
    attributes: selected ? TextAttributes.BOLD : TextAttributes.NONE,
    truncate: true,
    selectable: false,
    onMouseUp(event) {
      // OpenTUI publishes equivalent mouse-button values through separate enum declarations.
      // oxlint-disable-next-line typescript/no-unsafe-enum-comparison
      if (event.button !== MouseButton.LEFT) return
      event.preventDefault()
      event.stopPropagation()
      if (selected) controller.toggleSelected()
      else controller.select(row.callId)
    },
  })
}

function createToolList(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: ToolsController,
  snapshot: ToolsSnapshotView,
): ScrollBoxRenderable {
  const list = new ScrollBoxRenderable(renderer, {
    id: 'tools-list',
    width: '100%',
    flexGrow: 1,
    scrollY: true,
    scrollX: false,
  })
  if (snapshot.rows.length === 0) {
    list.add(new TextRenderable(renderer, {
      content: EMPTY_COPY,
      fg: theme.colors.muted,
      selectable: false,
    }))
  } else {
    for (const row of snapshot.rows) list.add(createToolRow(renderer, theme, controller, snapshot, row))
  }
  return list
}

function createDetails(
  renderer: CliRenderer,
  theme: TuiTheme,
  snapshot: ToolsSnapshotView,
): BoxRenderable {
  const details = new BoxRenderable(renderer, {
    id: 'tool-details',
    title: snapshot.selectedCallId === undefined ? 'OUTPUT' : `OUTPUT · ${snapshot.selectedCallId}`,
    width: '100%',
    height: DETAIL_BORDER_HEIGHT,
    border: true,
    borderStyle: 'single',
    borderColor: theme.colors.border,
    paddingX: 1,
  })
  const scroll = new ScrollBoxRenderable(renderer, {
    width: '100%',
    height: '100%',
    scrollY: true,
    scrollX: false,
  })
  scroll.add(new TextRenderable(renderer, {
    content: snapshot.details,
    fg: theme.colors.text,
    wrapMode: 'word',
    selectable: true,
  }))
  details.add(scroll)
  return details
}

function createFrame(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: ToolsController,
  snapshot: ToolsSnapshotView,
): BoxRenderable {
  const frame = new BoxRenderable(renderer, {
    id: 'tools-frame',
    width: '100%',
    height: '100%',
    flexDirection: 'column',
    backgroundColor: theme.colors.background,
  })
  frame.add(new TextRenderable(renderer, {
    content: `INSPECT · ${snapshot.title}`,
    height: HEADER_HEIGHT,
    fg: theme.colors.accent,
    attributes: TextAttributes.BOLD,
    truncate: true,
    selectable: false,
  }))
  frame.add(createToolList(renderer, theme, controller, snapshot))
  frame.add(createDetails(renderer, theme, snapshot))
  frame.add(new TextRenderable(renderer, {
    content: 'j/k or arrows move · Enter/click fold · g c returns to chat',
    height: STATUS_HEIGHT,
    fg: theme.colors.muted,
    attributes: TextAttributes.DIM,
    truncate: true,
    selectable: false,
  }))
  return frame
}

export function createToolsView(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: ToolsController,
): BoxRenderable {
  const root = new BoxRenderable(renderer, {
    id: 'dsh-tui-tools-view',
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
