import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextAttributes,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type Renderable,
} from '@opentui/core'
import type { TuiTheme } from '../../contracts/theme.js'
import type {
  ConversationController,
  ConversationQueueItemView,
  ConversationSnapshotView,
} from '../../features/conversation/model.js'
import { createFocusableAction } from '../action.js'

const QUEUE_DOCK_ID = 'conversation-queue'
const QUEUE_HEADER_ID = 'conversation-queue-header'
const QUEUE_LIST_ID = 'conversation-queue-list'
const QUEUE_ACTION_PREFIX = 'conversation-queue'
const QUEUE_EDIT_ID_FRAGMENT = `${QUEUE_ACTION_PREFIX}-edit-`
const QUEUE_TITLE = 'QUEUE'
const QUEUE_BUSY_MARK = '…'
const QUEUE_IDLE_MARK = '·'
const QUEUE_EDIT_ACTION = ' [EDIT] '
const QUEUE_REMOVE_ACTION = ' [REMOVE] '
const QUEUE_STEER_ACTION = ' [STEER] '
const QUEUE_STEER_ALL_ACTION = ' [STEER ALL] '
const QUEUE_ROW_HEIGHT = 1
const QUEUE_HEADER_HEIGHT = 1
const QUEUE_MAX_VISIBLE_ROWS = 3
const QUEUE_EDIT_WIDTH = 8
const QUEUE_REMOVE_WIDTH = 10
const QUEUE_STEER_WIDTH = 9
const QUEUE_STEER_ALL_WIDTH = 13
const ESCAPE_KEY = 'escape'

interface QueueFocusRing {
  readonly focusComposer: () => Renderable | undefined
  readonly nodes: TextRenderable[]
}

export interface ConversationQueueDock {
  readonly root: BoxRenderable
  focusFirst(): boolean
}

function actionId(action: 'edit' | 'remove' | 'steer', item: ConversationQueueItemView): string {
  return `${QUEUE_ACTION_PREFIX}-${action}-${String(item.id)}`
}

function adjacentAction(ring: QueueFocusRing, index: number, delta: number): Renderable | undefined {
  for (let candidate = index + delta; candidate >= 0 && candidate < ring.nodes.length; candidate += delta) {
    const node = ring.nodes[candidate]
    if (node?.focusable === true && !node.isDestroyed) return node
  }
  return ring.focusComposer()
}

function queueActionKey(key: KeyEvent, ring: QueueFocusRing): boolean {
  if (key.name !== ESCAPE_KEY) return false
  ring.focusComposer()?.focus()
  return true
}

function createQueueAction(
  renderer: CliRenderer,
  theme: TuiTheme,
  ring: QueueFocusRing,
  options: { readonly content: string; readonly enabled: boolean; readonly id: string; readonly width: number },
  run: () => void,
): TextRenderable {
  const index = ring.nodes.length
  const action = createFocusableAction(renderer, {
    ...options,
    fg: theme.colors.focus,
    handleKey: key => queueActionKey(key, ring),
    height: QUEUE_ROW_HEIGHT,
    mutedFg: theme.colors.muted,
    nextFocus: () => adjacentAction(ring, index, 1),
    previousFocus: () => adjacentAction(ring, index, -1),
    run,
  })
  ring.nodes.push(action)
  return action
}

function addQueueActions(
  row: BoxRenderable,
  renderer: CliRenderer,
  theme: TuiTheme,
  ring: QueueFocusRing,
  controller: ConversationController,
  snapshot: ConversationSnapshotView,
  item: ConversationQueueItemView,
): void {
  const mutable = snapshot.queueMutable && !item.busy
  row.add(createQueueAction(renderer, theme, ring, {
    content: QUEUE_EDIT_ACTION, enabled: mutable && item.editable,
    id: actionId('edit', item), width: QUEUE_EDIT_WIDTH,
  }, () => { controller.beginQueueEdit(item.id) }))
  row.add(createQueueAction(renderer, theme, ring, {
    content: QUEUE_REMOVE_ACTION, enabled: mutable,
    id: actionId('remove', item), width: QUEUE_REMOVE_WIDTH,
  }, () => { void controller.removeQueue(item.id) }))
  row.add(createQueueAction(renderer, theme, ring, {
    content: QUEUE_STEER_ACTION, enabled: mutable && snapshot.running,
    id: actionId('steer', item), width: QUEUE_STEER_WIDTH,
  }, () => { void controller.steerQueue(item.id) }))
}

function createQueueRow(
  renderer: CliRenderer,
  theme: TuiTheme,
  ring: QueueFocusRing,
  controller: ConversationController,
  snapshot: ConversationSnapshotView,
  item: ConversationQueueItemView,
): BoxRenderable {
  const row = new BoxRenderable(renderer, {
    id: `${QUEUE_ACTION_PREFIX}-row-${String(item.id)}`,
    width: '100%', height: QUEUE_ROW_HEIGHT, flexDirection: 'row', flexShrink: 0,
  })
  row.add(new TextRenderable(renderer, {
    content: `${item.busy ? QUEUE_BUSY_MARK : QUEUE_IDLE_MARK} ${item.preview}`,
    fg: item.busy ? theme.colors.warning : theme.colors.text,
    height: QUEUE_ROW_HEIGHT, truncate: true, selectable: true, flexGrow: 1,
  }))
  addQueueActions(row, renderer, theme, ring, controller, snapshot, item)
  return row
}

function createQueueHeader(
  renderer: CliRenderer,
  theme: TuiTheme,
  ring: QueueFocusRing,
  controller: ConversationController,
  snapshot: ConversationSnapshotView,
): BoxRenderable {
  const header = new BoxRenderable(renderer, {
    id: QUEUE_HEADER_ID,
    width: '100%', height: QUEUE_HEADER_HEIGHT, flexDirection: 'row', flexShrink: 0,
  })
  header.add(new TextRenderable(renderer, {
    content: `${QUEUE_TITLE} ${String(snapshot.queue.length)}`,
    fg: theme.colors.accent, attributes: TextAttributes.BOLD,
    height: QUEUE_HEADER_HEIGHT, selectable: false, flexGrow: 1,
  }))
  header.add(createQueueAction(renderer, theme, ring, {
    content: QUEUE_STEER_ALL_ACTION,
    enabled: snapshot.queueMutable && snapshot.running && !snapshot.queue.some(item => item.busy),
    id: `${QUEUE_ACTION_PREFIX}-steer-all`, width: QUEUE_STEER_ALL_WIDTH,
  }, () => { void controller.steerQueueAll() }))
  return header
}

function createQueueList(
  renderer: CliRenderer,
  theme: TuiTheme,
  ring: QueueFocusRing,
  controller: ConversationController,
  snapshot: ConversationSnapshotView,
  visibleRows: number,
): ScrollBoxRenderable {
  const list = new ScrollBoxRenderable(renderer, {
    id: QUEUE_LIST_ID, width: '100%', height: visibleRows, scrollY: true, scrollX: false,
  })
  for (const item of snapshot.queue) list.add(createQueueRow(renderer, theme, ring, controller, snapshot, item))
  return list
}

export function createConversationQueue(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: ConversationController,
  snapshot: ConversationSnapshotView,
  focusComposer: () => Renderable | undefined,
): ConversationQueueDock | undefined {
  if (snapshot.queue.length === 0) return undefined
  const ring: QueueFocusRing = { focusComposer, nodes: [] }
  const visibleRows = Math.min(snapshot.queue.length, QUEUE_MAX_VISIBLE_ROWS)
  const root = new BoxRenderable(renderer, {
    id: QUEUE_DOCK_ID,
    width: '100%', height: QUEUE_HEADER_HEIGHT + visibleRows,
    flexDirection: 'column', flexShrink: 0,
  })
  root.add(createQueueHeader(renderer, theme, ring, controller, snapshot))
  root.add(createQueueList(renderer, theme, ring, controller, snapshot, visibleRows))
  return {
    root,
    focusFirst() {
      const firstEdit = ring.nodes.find(node => node.id.startsWith(QUEUE_EDIT_ID_FRAGMENT) && node.focusable)
      const first = firstEdit ?? ring.nodes.find(node => node.focusable)
      if (first === undefined) return false
      first.focus()
      return true
    },
  }
}
