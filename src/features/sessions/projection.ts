import type { SessionId, WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionStatsProjection } from '@deepseek-ai/dsh-session-stats/client'
import type {
  SessionListState,
  SessionSearchResultItem,
  SessionSummary,
  WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionsRow } from './contracts.js'

export const UNGROUPED_ID = 'ungrouped'
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
    if (!control) sanitized += String.fromCodePoint(code)
    if (code > BMP_END) index += 1
  }
  return sanitized
}

function visibleSession(
  summary: SessionSummary,
  current: SessionId | undefined,
  archived: ReadonlySet<SessionId>,
): boolean {
  return summary.origin !== 'subagent'
    && !archived.has(summary.id)
    && (!summary.blank || summary.id === current)
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
): SessionsRow {
  return Object.freeze({
    key: `${SESSION_KEY_PREFIX}${summary.id}`,
    kind: 'session',
    title: sanitizeText(summary.blank ? 'New Session' : summary.displayTitle),
    detail: sessionDetail(summary),
    depth: 1,
    selected: summary.id === current,
    running: summary.running,
    pending: summary.pendingInteraction !== undefined,
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
    expanded,
    sessionId: undefined,
    workspaceId,
  })
}

export function initialExpanded(workspaces: WorkspaceListState): Set<string> {
  return new Set([...workspaces.items.map(item => item.workspaceId as string), UNGROUPED_ID])
}

export function projectRows(
  sessions: SessionListState,
  workspaces: WorkspaceListState,
  expandedIds: ReadonlySet<string>,
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
    const expanded = expandedIds.has(workspace.workspaceId)
    rows.push(createWorkspaceRow(workspace, expanded, members.length))
    if (expanded) rows.push(...members.map(summary => createSessionRow(summary, workspace.workspaceId, sessions.current)))
  }
  const ungrouped = sessions.ids.flatMap((id) => {
    const summary = sessions.byId[id]
    if (summary === undefined || accounted.has(id) || !visibleSession(summary, sessions.current, archived)) return []
    return [summary]
  })
  if (ungrouped.length > 0) {
    const expanded = expandedIds.has(UNGROUPED_ID)
    rows.push(createWorkspaceRow(undefined, expanded, ungrouped.length))
    if (expanded) rows.push(...ungrouped.map(summary => createSessionRow(summary, undefined, sessions.current)))
  }
  return rows
}

export function projectSearchRows(
  sessions: SessionListState,
  workspaces: WorkspaceListState,
  query: string,
  searchItems: readonly SessionSearchResultItem[],
): SessionsRow[] {
  const archived = new Set(workspaces.archivedSessionIds)
  const normalizedQuery = query.toLowerCase()
  const remoteById = new Map(searchItems.map(item => [item.sessionId, item]))
  const workspaceBySession = new Map<SessionId, WorkspaceId>()
  for (const workspace of workspaces.items) {
    for (const id of workspace.sessionIds) workspaceBySession.set(id, workspace.workspaceId)
  }
  return sessions.ids.flatMap((id) => {
    const summary = sessions.byId[id]
    if (summary === undefined || !visibleSession(summary, sessions.current, archived) || summary.blank) return []
    const titleMatch = summary.displayTitle.toLowerCase().includes(normalizedQuery)
    const remote = remoteById.get(id)
    if (!titleMatch && remote === undefined) return []
    const row = createSessionRow(summary, workspaceBySession.get(id), sessions.current)
    return [remote === undefined ? row : Object.freeze({ ...row, detail: sanitizeText(remote.snippet) })]
  })
}
