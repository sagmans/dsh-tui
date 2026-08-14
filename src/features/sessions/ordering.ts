import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  SessionListState,
  SessionSummary,
  WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client'

export const UNGROUPED_ID = 'ungrouped'
export const FLAT_ID = 'flat'

export interface SessionOrderAccount {
  readonly ids: readonly SessionId[]
  readonly key: string
}

export function visibleSession(
  summary: SessionSummary,
  current: SessionId | undefined,
  archived: ReadonlySet<SessionId>,
): boolean {
  return summary.origin !== 'subagent'
    && !archived.has(summary.id)
    && (!summary.blank || summary.id === current)
}

export function compareSummaryRecency(left: SessionSummary, right: SessionSummary): number {
  if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt
  return left.id < right.id ? -1 : 1
}

export function compareSessionRecency(
  left: SessionId,
  right: SessionId,
  byId: SessionListState['byId'],
): number {
  const leftUpdatedAt = byId[left]?.updatedAt ?? Number.NEGATIVE_INFINITY
  const rightUpdatedAt = byId[right]?.updatedAt ?? Number.NEGATIVE_INFINITY
  if (leftUpdatedAt !== rightUpdatedAt) return rightUpdatedAt - leftUpdatedAt
  return left < right ? -1 : 1
}

export function reconcileSessionOrder(
  ids: readonly SessionId[],
  stored: readonly SessionId[] | undefined,
): SessionId[] {
  if (stored === undefined) return [...ids]
  const available = new Set(ids)
  const included = new Set<SessionId>()
  const ordered: SessionId[] = []
  for (const id of stored) {
    if (!available.has(id) || included.has(id)) continue
    ordered.push(id)
    included.add(id)
  }
  for (const id of ids) {
    if (included.has(id)) continue
    ordered.push(id)
  }
  return ordered
}

export function flatSummaries(
  sessions: SessionListState,
  workspaces: WorkspaceListState,
  order?: readonly SessionId[],
): SessionSummary[] {
  const archived = new Set(workspaces.archivedSessionIds)
  const visible = sessions.ids.flatMap((id) => {
    const summary = sessions.byId[id]
    return summary !== undefined && visibleSession(summary, sessions.current, archived) ? [summary] : []
  })
  const base = order === undefined ? visible.toSorted(compareSummaryRecency) : visible
  const byId = new Map(base.map(summary => [summary.id, summary]))
  return reconcileSessionOrder(base.map(summary => summary.id), order).flatMap((id) => {
    const summary = byId.get(id)
    return summary === undefined ? [] : [summary]
  })
}

export function sessionOrderAccounts(
  sessions: SessionListState,
  workspaces: WorkspaceListState,
): readonly SessionOrderAccount[] {
  const accounted = new Set<SessionId>()
  const accounts: SessionOrderAccount[] = workspaces.items.map((workspace) => {
    const ids = workspace.sessionIds.filter((id) => {
      if (sessions.byId[id] === undefined) return false
      accounted.add(id)
      return true
    })
    return { key: workspace.workspaceId, ids }
  })
  const ungrouped = sessions.ids.filter(id => sessions.byId[id] !== undefined && !accounted.has(id))
  accounts.push(
    { key: UNGROUPED_ID, ids: ungrouped },
    { key: FLAT_ID, ids: flatSummaries(sessions, workspaces).map(summary => summary.id) },
  )
  return Object.freeze(accounts)
}
