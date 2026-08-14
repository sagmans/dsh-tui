import type { SessionId, WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionStatsProjection } from '@deepseek-ai/dsh-session-stats/client'
import type {
  SessionListState,
  SessionSearchResultItem,
  SessionSummary,
  WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionsGroupMode, SessionsRow } from './contracts.js'
import {
  compareSummaryRecency,
  FLAT_ID,
  flatSummaries,
  reconcileSessionOrder,
  UNGROUPED_ID,
  visibleSession,
} from './ordering.js'

export { FLAT_ID, UNGROUPED_ID } from './ordering.js'
export const SESSION_SEARCH_QUERY_LIMIT = 500
export const SESSION_SEARCH_RESULT_LIMIT = 20
const UNGROUPED_TITLE = 'Ungrouped'
const SESSION_KEY_PREFIX = 'session:'
const WORKSPACE_KEY_PREFIX = 'workspace:'
const ESCAPE_CODE = 27
const CSI_OPEN_CODE = 91
const OSC_OPEN_CODE = 93
const OSC_CLOSE_CODE = 7
const ESCAPE_CLOSE_CODE = 92
const CSI_FINAL_START = 64
const DELETE_CODE = 127
const CONTROL_ONE_END = 31
const CONTROL_TWO_START = 128
const CONTROL_TWO_END = 159
const BMP_END = 65_535
const ARABIC_LETTER_MARK_CODE = 1_564
const DIRECTIONAL_MARK_START = 8_206
const DIRECTIONAL_MARK_END = 8_207
const DIRECTIONAL_EMBEDDING_START = 8_234
const DIRECTIONAL_EMBEDDING_END = 8_238
const DIRECTIONAL_ISOLATE_START = 8_294
const DIRECTIONAL_ISOLATE_END = 8_297

export interface SessionsProjectionOptions {
  readonly groupMode: SessionsGroupMode
  readonly orders: ReadonlyMap<string, readonly SessionId[]>
}

function bidiFormatting(code: number): boolean {
  return code === ARABIC_LETTER_MARK_CODE
    || (code >= DIRECTIONAL_MARK_START && code <= DIRECTIONAL_MARK_END)
    || (code >= DIRECTIONAL_EMBEDDING_START && code <= DIRECTIONAL_EMBEDDING_END)
    || (code >= DIRECTIONAL_ISOLATE_START && code <= DIRECTIONAL_ISOLATE_END)
}

function skipCsi(value: string, start: number): number {
  let index = start
  while (index < value.length && (value.codePointAt(index) ?? 0) < CSI_FINAL_START) index += 1
  return index
}

function skipOsc(value: string, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    const current = value.codePointAt(index)
    if (current === OSC_CLOSE_CODE) return index
    if (current === ESCAPE_CODE && value.codePointAt(index + 1) === ESCAPE_CLOSE_CODE) return index + 1
  }
  return value.length
}

function skipEscape(value: string, index: number): number {
  const next = value.codePointAt(index + 1)
  if (next === CSI_OPEN_CODE) return skipCsi(value, index + 2)
  if (next === OSC_OPEN_CODE) return skipOsc(value, index + 2)
  return index
}

export function sanitizeText(value: string): string {
  let sanitized = ''
  for (let index = 0; index < value.length; index += 1) {
    const code = value.codePointAt(index)
    if (code === undefined) continue
    if (code === ESCAPE_CODE) {
      index = skipEscape(value, index)
      continue
    }
    const control = code <= CONTROL_ONE_END || code === DELETE_CODE
      || (code >= CONTROL_TWO_START && code <= CONTROL_TWO_END)
    if (!control && !bidiFormatting(code)) sanitized += String.fromCodePoint(code)
    if (code > BMP_END) index += 1
  }
  return sanitized
}

export function normalizeSessionSearchQuery(value: string): string {
  const sanitized = sanitizeText(value)
  if (sanitized.length <= SESSION_SEARCH_QUERY_LIMIT) return sanitized
  let end = SESSION_SEARCH_QUERY_LIMIT
  if ((sanitized.codePointAt(end - 1) ?? 0) > BMP_END) end -= 1
  return sanitized.slice(0, end)
}

function statsDetail(stats: SessionStatsProjection | undefined): string {
  return stats === undefined ? '' : ` · ${stats.turns}t/${stats.steps}s`
}

function sessionDetail(summary: SessionSummary): string {
  const stats = summary.projectionValues?.sessionStats
  if (summary.pendingInteraction !== undefined) return `${summary.pendingInteraction}${statsDetail(stats)}`
  if (summary.running) return `running${statsDetail(stats)}`
  if (summary.completed === true) return `done${statsDetail(stats)}`
  return `idle${statsDetail(stats)}`
}

function createSessionRow(
  summary: SessionSummary,
  workspaceId: WorkspaceId | undefined,
  current: SessionId | undefined,
  depth: number,
  detail = sessionDetail(summary),
): SessionsRow {
  return Object.freeze({
    key: `${SESSION_KEY_PREFIX}${summary.id}`,
    kind: 'session',
    title: sanitizeText(summary.blank ? 'New Session' : summary.displayTitle),
    detail: sanitizeText(detail),
    depth,
    selected: summary.id === current,
    running: summary.running,
    pending: summary.pendingInteraction !== undefined,
    unread: summary.completed === true,
    expanded: undefined,
    sessionId: summary.id,
    workspaceId,
  })
}

function createWorkspaceRow(
  workspace: WorkspaceView | undefined,
  expanded: boolean,
  count: number,
): SessionsRow {
  const workspaceId = workspace?.workspaceId
  return Object.freeze({
    key: `${WORKSPACE_KEY_PREFIX}${workspaceId ?? UNGROUPED_ID}`,
    kind: 'workspace',
    title: sanitizeText(workspace?.title ?? UNGROUPED_TITLE),
    detail: `${count} session${count === 1 ? '' : 's'}`,
    depth: 0,
    selected: false,
    running: false,
    pending: false,
    unread: false,
    expanded,
    sessionId: undefined,
    workspaceId,
  })
}

export function initialExpanded(workspaces: WorkspaceListState): Set<string> {
  return new Set([...workspaces.items.map(item => item.workspaceId as string), UNGROUPED_ID])
}

function orderedSummaries(
  members: readonly SessionSummary[],
  order: readonly SessionId[] | undefined,
): SessionSummary[] {
  const byId = new Map(members.map(summary => [summary.id, summary]))
  return reconcileSessionOrder(members.map(summary => summary.id), order).flatMap((id) => {
    const summary = byId.get(id)
    return summary === undefined ? [] : [summary]
  })
}

function workspaceBySession(workspaces: readonly WorkspaceView[]): Map<SessionId, WorkspaceView> {
  const result = new Map<SessionId, WorkspaceView>()
  for (const workspace of workspaces) {
    for (const id of workspace.sessionIds) {
      if (!result.has(id)) result.set(id, workspace)
    }
  }
  return result
}

function groupedRows(
  sessions: SessionListState,
  workspaces: WorkspaceListState,
  expandedIds: ReadonlySet<string>,
  orders: ReadonlyMap<string, readonly SessionId[]>,
): SessionsRow[] {
  const archived = new Set(workspaces.archivedSessionIds)
  const rows: SessionsRow[] = []
  const accounted = new Set<SessionId>()
  for (const workspace of workspaces.items) {
    const members = workspace.sessionIds.flatMap((id) => {
      const summary = sessions.byId[id]
      if (summary === undefined) return []
      accounted.add(id)
      return visibleSession(summary, sessions.current, archived) ? [summary] : []
    })
    const ordered = orderedSummaries(members, orders.get(workspace.workspaceId))
    const expanded = expandedIds.has(workspace.workspaceId)
    rows.push(createWorkspaceRow(workspace, expanded, ordered.length))
    if (expanded) {
      rows.push(...ordered.map(summary => createSessionRow(summary, workspace.workspaceId, sessions.current, 1)))
    }
  }
  const ungrouped = sessions.ids.flatMap((id) => {
    const summary = sessions.byId[id]
    if (summary === undefined || accounted.has(id) || !visibleSession(summary, sessions.current, archived)) return []
    return [summary]
  })
  if (ungrouped.length > 0) {
    const ordered = orderedSummaries(ungrouped, orders.get(UNGROUPED_ID))
    const expanded = expandedIds.has(UNGROUPED_ID)
    rows.push(createWorkspaceRow(undefined, expanded, ordered.length))
    if (expanded) rows.push(...ordered.map(summary => createSessionRow(summary, undefined, sessions.current, 1)))
  }
  return rows
}

export function projectRows(
  sessions: SessionListState,
  workspaces: WorkspaceListState,
  expandedIds: ReadonlySet<string>,
  options: SessionsProjectionOptions,
): SessionsRow[] {
  if (options.groupMode === 'workspace') {
    return groupedRows(sessions, workspaces, expandedIds, options.orders)
  }
  const owners = workspaceBySession(workspaces.items)
  return flatSummaries(sessions, workspaces, options.orders.get(FLAT_ID)).map((summary) => {
    return createSessionRow(summary, owners.get(summary.id)?.workspaceId, sessions.current, 0)
  })
}

function fallbackWorkspace(summary: SessionSummary): string {
  const cwd = summary.cwd
  if (cwd === undefined || cwd === '') return UNGROUPED_TITLE
  const basename = cwd.replace(/[/\\]+$/u, '').split(/[/\\]/u).pop()
  return basename === undefined || basename === '' ? cwd : basename
}

export interface SessionsSearchProjection {
  readonly hasMore: boolean
  readonly rows: readonly SessionsRow[]
}

export function projectSearch(
  sessions: SessionListState,
  workspaces: WorkspaceListState,
  query: string,
  searchItems: readonly SessionSearchResultItem[],
  remoteHasMore: boolean,
): SessionsSearchProjection {
  const archived = new Set(workspaces.archivedSessionIds)
  const normalizedQuery = normalizeSessionSearchQuery(query).trim().toLowerCase()
  if (normalizedQuery === '') return Object.freeze({ hasMore: false, rows: Object.freeze([]) })
  const owners = workspaceBySession(workspaces.items)
  const remoteById = new Map<SessionId, SessionSearchResultItem>()
  for (const item of searchItems) {
    if (!remoteById.has(item.sessionId)) remoteById.set(item.sessionId, item)
  }
  const local = sessions.ids.flatMap((id) => {
    const summary = sessions.byId[id]
    if (summary === undefined || summary.blank || !visibleSession(summary, sessions.current, archived)) return []
    const workspaceTitle = owners.get(id)?.title ?? fallbackWorkspace(summary)
    return sanitizeText(summary.displayTitle).toLowerCase().includes(normalizedQuery)
      || sanitizeText(workspaceTitle).toLowerCase().includes(normalizedQuery)
      ? [summary]
      : []
  }).toSorted(compareSummaryRecency)
  const localIds = new Set(local.map(summary => summary.id))
  const ordered = [...local]
  const included = new Set(localIds)
  for (const item of searchItems) {
    const summary = sessions.byId[item.sessionId]
    if (summary === undefined
      || summary.blank
      || included.has(summary.id)
      || !visibleSession(summary, sessions.current, archived)) continue
    included.add(summary.id)
    ordered.push(summary)
  }
  const rows = ordered.slice(0, SESSION_SEARCH_RESULT_LIMIT).map((summary) => {
    const remote = remoteById.get(summary.id)
    const owner = owners.get(summary.id)
    const detail = remote === undefined || localIds.has(summary.id)
      ? owner?.title ?? fallbackWorkspace(summary)
      : remote.snippet
    return createSessionRow(summary, owner?.workspaceId, sessions.current, 0, detail)
  })
  return Object.freeze({
    hasMore: remoteHasMore || ordered.length > SESSION_SEARCH_RESULT_LIMIT,
    rows: Object.freeze(rows),
  })
}
