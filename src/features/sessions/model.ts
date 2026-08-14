import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionSearchResultItem, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  SessionsController,
  SessionsControllerOptions,
  SessionsGroupMode,
  SessionsInputKind,
  SessionsInputState,
  SessionsOrderMode,
  SessionsPhase,
  SessionsRow,
  SessionsSnapshot,
  SessionsSource,
  WorkspacesSource,
} from './contracts.js'
import {
  compareSessionRecency,
  FLAT_ID,
  reconcileSessionOrder,
  sessionOrderAccounts,
  UNGROUPED_ID,
} from './ordering.js'
import {
  initialExpanded,
  normalizeSessionSearchQuery,
  projectRows,
  projectSearch,
  sanitizeText,
  type SessionsSearchProjection,
} from './projection.js'

export type * from './contracts.js'
export { normalizeSessionSearchQuery, sanitizeText } from './projection.js'

const SEARCH_TITLE = 'SEARCH SESSIONS'
const RENAME_SESSION_TITLE = 'RENAME SESSION'
const RENAME_WORKSPACE_TITLE = 'RENAME WORKSPACE'
const ADD_WORKSPACE_TITLE = 'ADD WORKSPACE'
const DIRECTORY_PLACEHOLDER = 'Existing directory path'
const INPUT_PLACEHOLDER = 'Type and press Enter'
const CHAT_ROUTE = 'chat'
const DEFAULT_GROUP_MODE: SessionsGroupMode = 'workspace'
const DEFAULT_ORDER_MODE: SessionsOrderMode = 'updated'

function resolvePhase(workspaces: WorkspaceListState, sessionsPending: boolean): SessionsPhase {
  if (workspaces.state === 'error') return 'error'
  if (workspaces.phase === 'pending' || sessionsPending) return 'loading'
  return 'ready'
}

function inputTitle(kind: SessionsInputKind, row: SessionsRow | undefined): string {
  switch (kind) {
    case 'create-workspace': return ADD_WORKSPACE_TITLE
    case 'rename': return row?.kind === 'session' ? RENAME_SESSION_TITLE : RENAME_WORKSPACE_TITLE
    case 'search': return SEARCH_TITLE
    default: {
      const exhaustive: never = kind
      throw new Error(`unhandled sessions input: ${String(exhaustive)}`)
    }
  }
}

class SessionsControllerService implements SessionsController {
  private readonly listeners = new Set<() => void>()
  private readonly navigation: SessionsControllerOptions['navigation']
  private readonly sessions: SessionsSource
  private readonly workspaces: WorkspacesSource
  private readonly resources: Array<() => void>
  private readonly expanded: Set<string>
  private readonly sessionOrders = new Map<string, SessionId[]>()
  private readonly sessionUpdatedAt = new Map<string, Map<SessionId, number>>()
  private activeRowKey: string | undefined
  private deleteWorkspaceId: SessionsRow['workspaceId']
  private error: string | undefined
  private groupMode: SessionsGroupMode = DEFAULT_GROUP_MODE
  private input: SessionsInputState | undefined
  private orderMode: SessionsOrderMode = DEFAULT_ORDER_MODE
  private searchAbort: AbortController | undefined
  private searchHasMore = false
  private searchItems: readonly SessionSearchResultItem[] = []
  private searchQuery = ''

  constructor(options: SessionsControllerOptions) {
    this.navigation = options.navigation
    this.sessions = options.sessions
    this.workspaces = options.workspaces
    this.expanded = initialExpanded(options.workspaces.list.getSnapshot())
    this.resources = [
      options.sessions.list.subscribe(() => { this.reconcile() }),
      options.workspaces.list.subscribe(() => { this.reconcile() }),
    ]
    this.reconcile(false)
  }

  accept(): void {
    if (this.deleteWorkspaceId === undefined) this.activate()
    else void this.confirmDelete()
  }

  activate(): void {
    if (this.interactionBlocked()) return
    const row = this.currentRow()
    if (row?.kind === 'workspace') {
      this.toggleWorkspace()
      return
    }
    if (row?.sessionId === undefined) return
    this.sessions.open(row.sessionId)
    this.navigation.go(CHAT_ROUTE)
  }

  async archive(): Promise<void> {
    if (this.interactionBlocked()) return
    const id = this.currentRow()?.sessionId
    if (id !== undefined) await this.runAction(() => this.workspaces.archiveSession(id))
  }

  cancel(): void {
    this.searchAbort?.abort()
    this.searchAbort = undefined
    if (this.deleteWorkspaceId !== undefined || this.input !== undefined) {
      this.deleteWorkspaceId = undefined
      this.input = undefined
    } else if (this.searchQuery === '') {
      this.navigation.go(CHAT_ROUTE)
    } else {
      this.searchHasMore = false
      this.searchItems = []
      this.searchQuery = ''
      this.reconcile(false)
    }
    this.publish()
  }

  close(): void {
    if (this.interactionBlocked()) return
    this.sessions.clear()
    this.navigation.go(CHAT_ROUTE)
  }

  async confirmDelete(): Promise<void> {
    const id = this.deleteWorkspaceId
    if (id === undefined) return
    this.deleteWorkspaceId = undefined
    await this.runAction(() => this.workspaces.delete(id))
  }

  deactivate(): void {
    this.searchAbort?.abort()
    this.searchAbort = undefined
    this.deleteWorkspaceId = undefined
    this.input = undefined
  }

  dispose(): void {
    this.deactivate()
    for (const dispose of this.resources.splice(0).toReversed()) dispose()
    this.listeners.clear()
  }

  async fork(): Promise<void> {
    if (this.interactionBlocked()) return
    const id = this.currentRow()?.sessionId
    if (id === undefined) return
    await this.runAction(async () => {
      const child = await this.sessions.fork({ sessionId: id })
      this.sessions.open(child)
      this.navigation.go(CHAT_ROUTE)
    })
  }

  getSnapshot(): SessionsSnapshot {
    const workspaces = this.workspaces.list.getSnapshot()
    const sessions = this.sessions.list.getSnapshot()
    const error = this.error ?? workspaces.error?.message
    const rows = Object.freeze(this.rows())
    return Object.freeze({
      activeRowKey: this.activeRowKey,
      confirmDelete: this.deleteWorkspaceId !== undefined,
      error: error === undefined ? undefined : sanitizeText(error),
      groupMode: this.groupMode,
      input: this.input,
      orderMode: this.orderMode,
      phase: resolvePhase(workspaces, sessions.phase === 'pending'),
      rows,
      searchHasMore: this.searchProjection().hasMore,
      searchQuery: this.searchQuery,
      unreadCount: this.flatRows().filter(row => row.unread).length,
    })
  }

  async loadOlder(): Promise<void> {
    if (this.interactionBlocked()) return
    const id = this.currentRow()?.sessionId
    if (id !== undefined) await this.runAction(() => this.sessions.loadOlder(id))
  }

  move(offset: number): void {
    if (this.deleteWorkspaceId !== undefined || this.input !== undefined) return
    const rows = this.rows()
    if (rows.length === 0) return
    const currentIndex = this.activeRowKey === undefined
      ? -1
      : rows.findIndex(row => row.key === this.activeRowKey)
    const start = Math.max(0, currentIndex)
    this.activeRowKey = rows[(start + offset + rows.length) % rows.length]?.key
    this.publish()
  }

  async moveSelected(offset: number): Promise<void> {
    if (this.interactionBlocked() || this.searchQuery !== '' || offset === 0) return
    const row = this.currentRow()
    if (row === undefined) return
    const delta = offset < 0 ? -1 : 1
    const workspaces = this.workspaces.list.getSnapshot().items
    if (row.kind === 'workspace') {
      const workspaceId = row.workspaceId
      if (workspaceId === undefined) return
      const index = workspaces.findIndex(item => item.workspaceId === workspaceId)
      if (!this.canMove(index, workspaces.length, delta)) return
      const before = delta < 0 ? workspaces[index - 1]?.workspaceId : workspaces[index + 2]?.workspaceId
      await this.runAction(() => this.workspaces.insertBefore(workspaceId, before))
      return
    }
    const sessionId = row.sessionId
    if (sessionId === undefined) return
    const siblings = this.rows().filter((candidate) => {
      return candidate.kind === 'session'
        && (this.groupMode === 'flat' || candidate.workspaceId === row.workspaceId)
    })
    const index = siblings.findIndex(candidate => candidate.sessionId === sessionId)
    if (!this.canMove(index, siblings.length, delta)) return
    const before = delta < 0
      ? siblings[index - 1]?.sessionId
      : siblings[index + 2]?.sessionId
    const account = this.groupMode === 'flat' ? FLAT_ID : row.workspaceId ?? UNGROUPED_ID
    this.moveSessionOrder(account, sessionId, before)
    this.publish()
    const workspaceId = row.workspaceId
    if (this.groupMode !== 'workspace' || this.orderMode !== 'manual' || workspaceId === undefined) return
    await this.runAction(() => this.workspaces.insertSessionBefore(
      workspaceId,
      sessionId,
      before,
    ).then(() => {}))
  }

  moveUnread(offset: number): void {
    if (this.interactionBlocked() || offset === 0) return
    const unread = this.flatRows().filter(row => row.unread)
    if (unread.length === 0) return
    const currentIndex = unread.findIndex(row => row.key === this.activeRowKey)
    const start = currentIndex === -1 ? (offset < 0 ? 0 : -1) : currentIndex
    const next = (start + offset % unread.length + unread.length) % unread.length
    const target = unread[next]
    if (target === undefined) return
    if (this.groupMode === 'workspace') this.expanded.add(target.workspaceId ?? UNGROUPED_ID)
    this.activeRowKey = target.key
    this.publish()
  }

  openInput(kind: SessionsInputKind): void {
    if (this.interactionBlocked()) return
    const row = this.currentRow()
    if (kind === 'rename' && row === undefined) return
    const initialValue = kind === 'rename' ? row?.title ?? '' : kind === 'search' ? this.searchQuery : ''
    const placeholder = kind === 'create-workspace' ? DIRECTORY_PLACEHOLDER : INPUT_PLACEHOLDER
    this.input = Object.freeze({
      kind,
      initialValue,
      placeholder,
      title: inputTitle(kind, row),
      sessionId: row?.sessionId,
      workspaceId: row?.workspaceId,
    })
    this.deleteWorkspaceId = undefined
    this.error = undefined
    this.publish()
  }

  requestDelete(): void {
    if (this.interactionBlocked()) return
    const row = this.currentRow()
    if (row?.kind !== 'workspace' || row.workspaceId === undefined) return
    this.deleteWorkspaceId = row.workspaceId
    this.input = undefined
    this.publish()
  }

  select(key: string): void {
    if (this.interactionBlocked() || !this.rows().some(row => row.key === key)) return
    this.activeRowKey = key
    this.publish()
  }

  setGroupMode(mode: SessionsGroupMode): void {
    if (this.interactionBlocked() || mode === this.groupMode) return
    this.groupMode = mode
    this.reconcile()
  }

  setOrderMode(mode: SessionsOrderMode): void {
    if (this.interactionBlocked() || mode === this.orderMode) return
    this.orderMode = mode
    this.syncSessionOrders(mode === 'updated')
    this.reconcile()
  }

  startSession(): void {
    if (this.interactionBlocked()) return
    this.workspaces.startSession(this.currentRow()?.workspaceId)
  }

  async submitInput(value: string): Promise<void> {
    const input = this.input
    if (input === undefined) return
    const normalized = (input.kind === 'search'
      ? normalizeSessionSearchQuery(value)
      : sanitizeText(value)).trim()
    if (normalized.length === 0) return
    this.input = undefined
    this.publish()
    switch (input.kind) {
      case 'create-workspace':
        await this.runAction(async () => {
          const created = await this.workspaces.create({ path: normalized })
          this.workspaces.startSession(created.workspaceId)
        })
        break
      case 'rename': await this.renameTarget(input, normalized); break
      case 'search': await this.search(normalized); break
      default: {
        const exhaustive: never = input.kind
        throw new Error(`unhandled sessions input: ${String(exhaustive)}`)
      }
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  toggleWorkspace(): void {
    if (this.interactionBlocked()) return
    const row = this.currentRow()
    if (row?.kind !== 'workspace') return
    const key = row.workspaceId ?? UNGROUPED_ID
    if (this.expanded.has(key)) this.expanded.delete(key)
    else this.expanded.add(key)
    this.reconcile()
  }

  private canMove(index: number, length: number, offset: number): boolean {
    return index >= 0 && (offset < 0 ? index > 0 : index < length - 1)
  }

  private flatRows(): SessionsRow[] {
    return projectRows(
      this.sessions.list.getSnapshot(),
      this.workspaces.list.getSnapshot(),
      this.expanded,
      { groupMode: 'flat', orders: this.sessionOrders },
    )
  }

  private moveSessionOrder(accountKey: string, sessionId: SessionId, before: SessionId | undefined): void {
    const account = sessionOrderAccounts(
      this.sessions.list.getSnapshot(),
      this.workspaces.list.getSnapshot(),
    ).find(candidate => candidate.key === accountKey)
    if (account === undefined) return
    const order = reconcileSessionOrder(account.ids, this.sessionOrders.get(accountKey))
      .filter(id => id !== sessionId)
    const target = before === undefined ? order.length : order.indexOf(before)
    order.splice(target === -1 ? order.length : target, 0, sessionId)
    this.sessionOrders.set(accountKey, order)
  }

  private syncSessionOrders(forceRecency = false): void {
    const sessions = this.sessions.list.getSnapshot()
    const accounts = sessionOrderAccounts(sessions, this.workspaces.list.getSnapshot())
    const live = new Set(accounts.map(account => account.key))
    for (const account of accounts) {
      const previousOrder = this.sessionOrders.get(account.key)
      const previousUpdatedAt = this.sessionUpdatedAt.get(account.key) ?? new Map<SessionId, number>()
      let order = reconcileSessionOrder(account.ids, previousOrder)
      if (this.orderMode === 'updated' && (forceRecency || previousOrder === undefined)) {
        order = order.toSorted((left, right) => compareSessionRecency(left, right, sessions.byId))
      } else if (this.orderMode === 'updated') {
        const promoted = account.ids.filter((id) => {
          const updatedAt = sessions.byId[id]?.updatedAt
          const previous = previousUpdatedAt.get(id)
          return updatedAt !== undefined && (previous === undefined || updatedAt > previous)
        }).toSorted((left, right) => compareSessionRecency(left, right, sessions.byId))
        if (promoted.length > 0) {
          const promotedIds = new Set(promoted)
          order = [...promoted, ...order.filter(id => !promotedIds.has(id))]
        }
      }
      this.sessionOrders.set(account.key, order)
      const updatedAtById = new Map<SessionId, number>()
      for (const id of account.ids) {
        const updatedAt = sessions.byId[id]?.updatedAt
        if (updatedAt !== undefined) updatedAtById.set(id, updatedAt)
      }
      this.sessionUpdatedAt.set(account.key, updatedAtById)
    }
    for (const key of this.sessionOrders.keys()) {
      if (!live.has(key)) this.sessionOrders.delete(key)
    }
    for (const key of this.sessionUpdatedAt.keys()) {
      if (!live.has(key)) this.sessionUpdatedAt.delete(key)
    }
  }

  private currentRow(): SessionsRow | undefined {
    return this.rows().find(row => row.key === this.activeRowKey)
  }

  private interactionBlocked(): boolean {
    return this.deleteWorkspaceId !== undefined || this.input !== undefined
  }

  private pruneExpanded(workspaces: WorkspaceListState): void {
    const liveIds = new Set([
      ...workspaces.items.map(item => item.workspaceId as string),
      UNGROUPED_ID,
    ])
    for (const id of this.expanded) {
      if (!liveIds.has(id)) this.expanded.delete(id)
    }
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
  }

  private reconcile(publish = true): void {
    this.syncSessionOrders()
    this.pruneExpanded(this.workspaces.list.getSnapshot())
    const rows = this.rows()
    if (this.activeRowKey === undefined || !rows.some(row => row.key === this.activeRowKey)) {
      this.activeRowKey = rows.find(row => row.selected)?.key ?? rows[0]?.key
    }
    if (publish) this.publish()
  }

  private async renameTarget(input: SessionsInputState, title: string): Promise<void> {
    const sessionId = input.sessionId
    const workspaceId = input.workspaceId
    if (sessionId !== undefined) {
      await this.runAction(() => this.sessions.rename(sessionId, title))
    } else if (workspaceId !== undefined) {
      await this.runAction(() => this.workspaces.rename(workspaceId, title).then(() => {}))
    }
  }

  private rows(): SessionsRow[] {
    const sessions = this.sessions.list.getSnapshot()
    const workspaces = this.workspaces.list.getSnapshot()
    return this.searchQuery === ''
      ? projectRows(sessions, workspaces, this.expanded, {
          groupMode: this.groupMode,
          orders: this.sessionOrders,
        })
      : [...this.searchProjection().rows]
  }

  private searchProjection(): SessionsSearchProjection {
    return projectSearch(
      this.sessions.list.getSnapshot(),
      this.workspaces.list.getSnapshot(),
      this.searchQuery,
      this.searchItems,
      this.searchHasMore,
    )
  }

  private async search(query: string): Promise<void> {
    this.searchAbort?.abort()
    const abort = new AbortController()
    this.searchAbort = abort
    this.searchQuery = query
    this.searchHasMore = false
    this.searchItems = []
    this.publish()
    try {
      const result = await this.sessions.search(query, abort.signal)
      if (abort.signal.aborted || this.searchAbort !== abort) return
      this.searchAbort = undefined
      if (result.ok) {
        this.searchHasMore = result.value.hasMore
        this.searchItems = result.value.items
        this.error = undefined
      } else this.error = sanitizeText(result.error.message)
    } catch (error) {
      if (abort.signal.aborted || this.searchAbort !== abort) return
      this.searchAbort = undefined
      this.error = sanitizeText(error instanceof Error ? error.message : String(error))
    }
    this.reconcile()
  }

  private async runAction(action: () => Promise<void>): Promise<void> {
    try {
      await action()
      this.error = undefined
    } catch (error) {
      this.error = sanitizeText(error instanceof Error ? error.message : String(error))
    }
    this.publish()
  }
}

export function createSessionsController(options: SessionsControllerOptions): SessionsController {
  return new SessionsControllerService(options)
}
