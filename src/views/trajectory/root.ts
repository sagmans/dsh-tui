import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
  TextAttributes,
  TextRenderable,
  type CliRenderer,
  type Renderable,
} from '@opentui/core'
import type { TuiTheme } from '../../contracts/theme.js'
import type {
  TrajectoryController,
  TrajectoryDetailTab,
  TrajectoryRowView,
  TrajectorySnapshotView,
  TrajectoryTimelineSpanView,
} from '../../features/trajectory/model.js'
import { createFocusableAction, createInputActions } from '../action.js'

const OVERLAY_Z_INDEX = 310
const OVERLAY_PADDING = 1
const CONTROL_HEIGHT = 1
const TOTAL_HEIGHT = 1
const TIMELINE_HEIGHT = 5
const ROW_HEIGHT = 1
const DETAIL_HEIGHT = 8
const DETAIL_TAB_HEIGHT = 1
const SEARCH_OVERLAY_Z_INDEX = 320
const SEARCH_OVERLAY_WIDTH = '72%'
const SEARCH_OVERLAY_HEIGHT = 6
const SEARCH_OVERLAY_LEFT = '14%'
const SEARCH_OVERLAY_TOP = '18%'
const TIMELINE_COLUMNS = 52
const TIMELINE_LANES = 3
const TIMELINE_POINT = '●'
const TIMELINE_FILL = '─'
const TIMELINE_EMPTY = ' '
const COLLAPSED_MARKER = '›'
const EXPANDED_MARKER = '⌄'
const LEAF_MARKER = '·'
const SELECTED_MARKER = '›'
const IDLE_MARKER = ' '
const ERROR_MARKER = '!'
const RECORD_MARKER = '·'
const ESCAPE_KEY = 'escape'
const INPUT_ACTION_PREFIX = 'trajectory-search-input'
const EMPTY_LEDGER = 'No trajectory records.'
const DETAIL_TAB_ORDER = Object.freeze([
  'input',
  'output',
  'timing',
  'raw',
] as const satisfies readonly TrajectoryDetailTab[])
const DETAIL_TAB_LABELS: Readonly<Record<TrajectoryDetailTab, string>> = Object.freeze({
  input: 'INPUT',
  output: 'OUTPUT',
  raw: 'RAW',
  timing: 'TIMING',
})

interface ControlDefinition {
  readonly enabled?: boolean
  readonly id: string
  readonly label: string
  readonly run: () => void
}

function rowDisclosure(row: TrajectoryRowView): string {
  if (!row.foldable) return LEAF_MARKER
  return row.collapsed ? COLLAPSED_MARKER : EXPANDED_MARKER
}

function rowContent(row: TrajectoryRowView, selected: boolean): string {
  const cursor = selected ? SELECTED_MARKER : IDLE_MARKER
  const state = row.error ? ERROR_MARKER : RECORD_MARKER
  const indent = ' '.repeat(row.depth * 2)
  const preview = row.preview === '' ? '' : ` · ${row.preview}`
  return `${cursor}${indent}${state} ${row.label}${preview}`
}

function controls(
  renderer: CliRenderer,
  theme: TuiTheme,
  snapshot: TrajectorySnapshotView,
  controller: TrajectoryController,
): BoxRenderable {
  const root = new BoxRenderable(renderer, {
    id: 'trajectory-controls',
    width: '100%',
    height: CONTROL_HEIGHT,
    flexDirection: 'row',
  })
  const definitions: readonly ControlDefinition[] = [
    { id: 'trajectory-close', label: 'CLOSE', run: () => { controller.close() } },
    { id: 'trajectory-search', label: 'SEARCH', run: () => { controller.openSearch() } },
    { enabled: snapshot.query !== '', id: 'trajectory-search-clear', label: 'CLEAR', run: () => { controller.clearSearch() } },
    { enabled: snapshot.hasMore && !snapshot.busy, id: 'trajectory-load-older', label: 'OLDER', run: () => { void controller.loadOlder() } },
    { id: 'trajectory-timeline-mode', label: snapshot.timeline.mode.toUpperCase(), run: () => { controller.toggleTimelineMode() } },
  ]
  const actions: Renderable[] = []
  definitions.forEach((definition, index) => {
    const action = createFocusableAction(renderer, {
      content: ` ${definition.label} `,
      ...definition.enabled === undefined ? {} : { enabled: definition.enabled },
      fg: theme.colors.focus,
      height: CONTROL_HEIGHT,
      id: definition.id,
      mutedFg: theme.colors.muted,
      nextFocus: () => actions[(index + 1) % actions.length],
      previousFocus: () => actions[(index - 1 + actions.length) % actions.length],
      run: definition.run,
    })
    actions.push(action)
    root.add(action)
  })
  root.add(new TextRenderable(renderer, {
    content: `  ${snapshot.status}`,
    fg: snapshot.error === undefined ? theme.colors.muted : theme.colors.danger,
    height: CONTROL_HEIGHT,
    truncate: true,
    selectable: false,
    flexGrow: 1,
  }))
  return root
}

function totals(
  renderer: CliRenderer,
  theme: TuiTheme,
  snapshot: TrajectorySnapshotView,
): TextRenderable {
  const value = snapshot.aggregate
  return new TextRenderable(renderer, {
    id: 'trajectory-totals',
    content: [
      `${String(value.turns)} turns`,
      `${String(value.steps)} steps`,
      `${String(value.records)} records`,
      `in ${String(value.inputTokens)}`,
      `out ${String(value.outputTokens)}`,
      `think ${String(value.reasoningTokens)}`,
      `cache ${String(value.cacheReadTokens)}/${String(value.cacheWriteTokens)}`,
      `${String(Math.round(value.durationMs))} ms`,
    ].join(' · '),
    fg: theme.colors.accent,
    height: TOTAL_HEIGHT,
    attributes: TextAttributes.BOLD,
    truncate: true,
    selectable: false,
  })
}

function timelinePosition(
  span: TrajectoryTimelineSpanView,
  spans: readonly TrajectoryTimelineSpanView[],
  mode: TrajectorySnapshotView['timeline']['mode'],
): { readonly end: number; readonly start: number } {
  if (mode === 'sequence') {
    const domainStart = Math.min(...spans.map(candidate => candidate.sequence))
    const domainEnd = Math.max(...spans.map(candidate => candidate.sequence))
    const domain = Math.max(1, domainEnd - domainStart)
    const point = Math.round((span.sequence - domainStart) * (TIMELINE_COLUMNS - 1) / domain)
    return { end: point, start: point }
  }
  const domainStart = Math.min(...spans.map(candidate => candidate.startTime))
  const domainEnd = Math.max(...spans.map(candidate => candidate.endTime ?? candidate.startTime))
  const domain = Math.max(1, domainEnd - domainStart)
  const start = Math.round((span.startTime - domainStart) * (TIMELINE_COLUMNS - 1) / domain)
  const endTime = span.endTime ?? span.startTime
  const end = Math.round((endTime - domainStart) * (TIMELINE_COLUMNS - 1) / domain)
  return { end: Math.max(start, end), start }
}

function timelineLine(
  spans: readonly TrajectoryTimelineSpanView[],
  lane: number,
  mode: TrajectorySnapshotView['timeline']['mode'],
): string {
  const cells = Array.from({ length: TIMELINE_COLUMNS }, () => TIMELINE_EMPTY)
  spans.forEach((span) => {
    if (span.lane !== lane) return
    const position = timelinePosition(span, spans, mode)
    for (let column = position.start; column <= position.end; column++) cells[column] = TIMELINE_FILL
    cells[position.start] = TIMELINE_POINT
  })
  return cells.join('')
}

function timeline(
  renderer: CliRenderer,
  theme: TuiTheme,
  snapshot: TrajectorySnapshotView,
): BoxRenderable {
  const root = new BoxRenderable(renderer, {
    id: 'trajectory-timeline',
    title: `TIMELINE · ${snapshot.timeline.mode.toUpperCase()}`,
    width: '100%',
    height: TIMELINE_HEIGHT,
    border: true,
    borderStyle: 'single',
    borderColor: theme.colors.border,
    flexDirection: 'column',
  })
  const laneLabels = ['SYS ', 'MSG ', 'TOOL'] as const
  for (let lane = 0; lane < TIMELINE_LANES; lane++) {
    root.add(new TextRenderable(renderer, {
      content: `${laneLabels[lane] ?? ''} ${timelineLine(snapshot.timeline.spans, lane, snapshot.timeline.mode)}`,
      fg: lane === 2 ? theme.colors.warning : lane === 1 ? theme.colors.focus : theme.colors.muted,
      height: ROW_HEIGHT,
      truncate: true,
      selectable: false,
    }))
  }
  return root
}

function ledgerRow(
  renderer: CliRenderer,
  theme: TuiTheme,
  snapshot: TrajectorySnapshotView,
  controller: TrajectoryController,
  row: TrajectoryRowView,
  index: number,
): BoxRenderable {
  const root = new BoxRenderable(renderer, {
    id: `trajectory-row-frame-${String(index)}`,
    width: '100%',
    height: ROW_HEIGHT,
    flexDirection: 'row',
  })
  const selected = index === snapshot.rowIndex
  const fold = createFocusableAction(renderer, {
    content: rowDisclosure(row),
    enabled: row.foldable,
    fg: theme.colors.focus,
    height: ROW_HEIGHT,
    id: `trajectory-fold-${String(index)}`,
    mutedFg: theme.colors.muted,
    nextFocus: () => action,
    run: () => {
      controller.selectRow(index)
      controller.toggleFold()
    },
  })
  const action = createFocusableAction(renderer, {
    content: rowContent(row, selected),
    fg: row.error ? theme.colors.danger : selected ? theme.colors.focus : theme.colors.text,
    height: ROW_HEIGHT,
    id: `trajectory-row-${String(index)}`,
    mutedFg: theme.colors.muted,
    previousFocus: () => row.foldable ? fold : undefined,
    run: () => { controller.selectRow(index) },
    width: 'auto',
  })
  root.add(fold)
  root.add(action)
  return root
}

function ledger(
  renderer: CliRenderer,
  theme: TuiTheme,
  snapshot: TrajectorySnapshotView,
  controller: TrajectoryController,
): ScrollBoxRenderable {
  const root = new ScrollBoxRenderable(renderer, {
    id: 'trajectory-ledger',
    width: '100%',
    flexGrow: 1,
    scrollY: true,
    scrollX: false,
  })
  if (snapshot.rows.length === 0) {
    root.add(new TextRenderable(renderer, { content: EMPTY_LEDGER, fg: theme.colors.muted, selectable: false }))
    return root
  }
  snapshot.rows.forEach((row, index) => { root.add(ledgerRow(renderer, theme, snapshot, controller, row, index)) })
  queueMicrotask(() => {
    if (root.isDestroyed || snapshot.searchInput !== undefined) return
    const id = `trajectory-row-${String(snapshot.rowIndex)}`
    root.scrollChildIntoView(id)
    root.findDescendantById(id)?.focus()
  })
  return root
}

function detailText(snapshot: TrajectorySnapshotView): string {
  switch (snapshot.detailTab) {
    case 'input': return snapshot.details.input
    case 'output': return snapshot.details.output
    case 'timing': return snapshot.details.timing
    case 'raw': return snapshot.details.raw
    default: {
      const exhaustive: never = snapshot.detailTab
      return exhaustive
    }
  }
}

function details(
  renderer: CliRenderer,
  theme: TuiTheme,
  snapshot: TrajectorySnapshotView,
  controller: TrajectoryController,
): BoxRenderable {
  const root = new BoxRenderable(renderer, {
    id: 'trajectory-details',
    title: snapshot.selectedKey ?? 'DETAILS',
    width: '100%',
    height: DETAIL_HEIGHT,
    flexShrink: 0,
    border: true,
    borderStyle: 'single',
    borderColor: theme.colors.border,
    flexDirection: 'column',
  })
  const tabs = new BoxRenderable(renderer, {
    id: 'trajectory-detail-tabs',
    width: '100%',
    height: DETAIL_TAB_HEIGHT,
    flexDirection: 'row',
  })
  for (const tab of DETAIL_TAB_ORDER) {
    tabs.add(createFocusableAction(renderer, {
      content: ` ${DETAIL_TAB_LABELS[tab]} `,
      fg: snapshot.detailTab === tab ? theme.colors.focus : theme.colors.muted,
      height: DETAIL_TAB_HEIGHT,
      id: `trajectory-detail-${tab}`,
      mutedFg: theme.colors.muted,
      run: () => { controller.selectDetailTab(tab) },
    }))
  }
  root.add(tabs)
  const scroll = new ScrollBoxRenderable(renderer, {
    id: 'trajectory-detail-content',
    width: '100%',
    flexGrow: 1,
    scrollY: true,
    scrollX: false,
  })
  scroll.add(new TextRenderable(renderer, {
    content: detailText(snapshot),
    fg: theme.colors.text,
    wrapMode: 'word',
    selectable: true,
  }))
  root.add(scroll)
  return root
}

function searchOverlay(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: TrajectoryController,
  initialValue: string,
): BoxRenderable {
  const root = new BoxRenderable(renderer, {
    id: 'trajectory-search-overlay',
    title: 'SEARCH TRAJECTORY',
    position: 'absolute',
    width: SEARCH_OVERLAY_WIDTH,
    height: SEARCH_OVERLAY_HEIGHT,
    left: SEARCH_OVERLAY_LEFT,
    top: SEARCH_OVERLAY_TOP,
    zIndex: SEARCH_OVERLAY_Z_INDEX,
    border: true,
    borderStyle: 'rounded',
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.background,
    paddingX: OVERLAY_PADDING,
    paddingY: OVERLAY_PADDING,
    flexDirection: 'column',
  })
  const input = new InputRenderable(renderer, {
    id: 'trajectory-search-input',
    value: initialValue,
    placeholder: 'Search complete record details',
    textColor: theme.colors.text,
    cursorColor: theme.colors.focus,
    focusedTextColor: theme.colors.text,
    focusedBackgroundColor: theme.colors.background,
    onKeyDown(key) {
      if (inputActions.focusForTab(key)) return
      if (key.name !== ESCAPE_KEY) return
      key.preventDefault()
      key.stopPropagation()
      controller.cancelSearch()
    },
  })
  const save = (): void => {
    controller.setSearchInput(input.plainText)
    controller.submitSearch()
  }
  input.on(InputRenderableEvents.ENTER, save)
  const inputActions = createInputActions(renderer, theme, {
    cancel: () => { controller.cancelSearch() },
    idPrefix: INPUT_ACTION_PREFIX,
    input,
    save,
  })
  root.add(input)
  root.add(inputActions.root)
  queueMicrotask(() => {
    if (input.isDestroyed) return
    input.cursorOffset = input.plainText.length
    input.focus()
  })
  return root
}

function frame(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: TrajectoryController,
  snapshot: TrajectorySnapshotView,
): BoxRenderable {
  const root = new BoxRenderable(renderer, {
    id: 'trajectory-frame',
    title: 'TRAJECTORY',
    position: 'absolute',
    width: '100%',
    height: '100%',
    left: 0,
    top: 0,
    zIndex: OVERLAY_Z_INDEX,
    border: true,
    borderStyle: 'rounded',
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.background,
    paddingX: OVERLAY_PADDING,
    paddingY: OVERLAY_PADDING,
    flexDirection: 'column',
  })
  root.add(controls(renderer, theme, snapshot, controller))
  root.add(totals(renderer, theme, snapshot))
  root.add(timeline(renderer, theme, snapshot))
  root.add(ledger(renderer, theme, snapshot, controller))
  root.add(details(renderer, theme, snapshot, controller))
  if (snapshot.searchInput !== undefined) root.add(searchOverlay(renderer, theme, controller, snapshot.searchInput))
  return root
}

export function createTrajectoryView(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: TrajectoryController,
): BoxRenderable {
  const root = new BoxRenderable(renderer, {
    id: 'dsh-tui-trajectory-view',
    width: '100%',
    height: '100%',
    backgroundColor: theme.colors.background,
  })
  let current = frame(renderer, theme, controller, controller.getSnapshot())
  root.add(current)
  const unsubscribe = controller.subscribe(() => {
    const next = frame(renderer, theme, controller, controller.getSnapshot())
    root.remove(current)
    current.destroyRecursively()
    current = next
    root.add(current)
  })
  root.once('destroyed', unsubscribe)
  return root
}
