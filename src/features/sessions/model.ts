import type { SessionSearchResultItem, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  SessionsController,
  SessionsControllerOptions,
  SessionsInputKind,
  SessionsInputState,
  SessionsPhase,
  SessionsRow,
  SessionsSnapshot,
  SessionsSource,
  WorkspacesSource,
} from './contracts.js'
import {
  initialExpanded,
  projectRows,
  projectSearchRows,
  sanitizeText,
  UNGROUPED_ID,
} from './projection.js'

export type * from './contracts.js'
export { sanitizeText } from './projection.js'

const SEARCH_TITLE = 'SEARCH SESSIONS'
const RENAME_SESSION_TITLE = 'RENAME SESSION'
const RENAME_WORKSPACE_TITLE = 'RENAME WORKSPACE'
const ADD_WORKSPACE_TITLE = 'ADD WORKSPACE'
const DIRECTORY_PLACEHOLDER = 'Existing directory path'
const INPUT_PLACEHOLDER = 'Type and press Enter'
const CHAT_ROUTE = 'chat'

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
  private activeRowKey: string | undefined
  private deleteWorkspaceId: SessionsRow['workspaceId']
  private error: string | undefined
  private input: SessionsInputState | undefined
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
    return Object.freeze({
      activeRowKey: this.activeRowKey,
      confirmDelete: this.deleteWorkspaceId !== undefined,
      error: error === undefined ? undefined : sanitizeText(error),
      input: this.input,
      phase: resolvePhase(workspaces, sessions.phase === 'pending'),
      rows: Object.freeze(this.rows()),
      searchHasMore: this.searchHasMore,
      searchQuery: this.searchQuery,
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
    if (this.interactionBlocked()) return
    const row = this.currentRow()
    const workspaceId = row?.workspaceId
    if (row === undefined || workspaceId === undefined || offset === 0) return
    const workspaces = this.workspaces.list.getSnapshot().items
    if (row.kind === 'workspace') {
      const index = workspaces.findIndex(item => item.workspaceId === workspaceId)
      if (!this.canMove(index, workspaces.length, offset)) return
      const before = offset < 0 ? workspaces[index - 1]?.workspaceId : workspaces[index + 2]?.workspaceId
      await this.runAction(() => this.workspaces.insertBefore(workspaceId, before))
      return
    }
    const sessionId = row.sessionId
    if (sessionId === undefined) return
    const workspace = workspaces.find(item => item.workspaceId === workspaceId)
    if (workspace === undefined) return
    const index = workspace.sessionIds.indexOf(sessionId)
    if (!this.canMove(index, workspace.sessionIds.length, offset)) return
    const before = offset < 0 ? workspace.sessionIds[index - 1] : workspace.sessionIds[index + 2]
    await this.runAction(() => this.workspaces.insertSessionBefore(
      workspace.workspaceId,
      sessionId,
      before,
    ).then(() => {}))
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

  startSession(): void {
    if (this.interactionBlocked()) return
    this.workspaces.startSession(this.currentRow()?.workspaceId)
  }

  async submitInput(value: string): Promise<void> {
    const input = this.input
    if (input === undefined) return
    const normalized = sanitizeText(value).trim()
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
      ? projectRows(sessions, workspaces, this.expanded)
      : projectSearchRows(sessions, workspaces, this.searchQuery, this.searchItems)
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
