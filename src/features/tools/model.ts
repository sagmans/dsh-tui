import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ToolInspectorRow,
  ToolPresentation,
  ToolsController,
  ToolsControllerOptions,
  ToolsSessionBinding,
  ToolsSnapshotView,
} from './contracts.js'
import { sanitizeText } from '../sessions/projection.js'

export type * from './contracts.js'

const EMPTY_TITLE = 'NO TOOL CALLS'
const MAX_TOOL_DEPTH = 64
const MAX_TOOL_ROWS = 1_000
const CONFIRM_OPEN_COPY = 'Press o again to open externally.'
const NO_PATH_COPY = 'Selected tool has no produced file.'
const OPEN_UNAVAILABLE_COPY = 'External open unavailable.'
const OPENED_PREFIX = 'Opened externally'
const OPEN_FAILED_PREFIX = 'External open failed'
const STATUS_SEPARATOR = ': '

function errorText(error: unknown): string {
  return sanitizeText(error instanceof Error ? error.message : String(error))
}

interface FlattenedTool {
  readonly depth: number
  readonly presentation: ToolPresentation
}

function toolsOf(snapshot: ConversationSnapshot | undefined): readonly ToolPresentation[] {
  return snapshot?.views.get('tui')?.tools ?? []
}

function flattenTools(
  tools: readonly ToolPresentation[],
  collapsed: ReadonlySet<string>,
): readonly FlattenedTool[] {
  const rows: FlattenedTool[] = []
  const visit = (tool: ToolPresentation, depth: number, ancestors: ReadonlySet<string>): void => {
    if (rows.length >= MAX_TOOL_ROWS || depth > MAX_TOOL_DEPTH || ancestors.has(tool.callId)) return
    rows.push({ depth, presentation: tool })
    if (collapsed.has(tool.callId)) return
    const nextAncestors = new Set([...ancestors, tool.callId])
    for (const child of tool.children) visit(child, depth + 1, nextAncestors)
  }
  for (const tool of tools) visit(tool, 0, new Set())
  return rows
}

class ToolsControllerService implements ToolsController {
  private readonly collapsed = new Set<string>()
  private readonly listeners = new Set<() => void>()
  private readonly openPath: ToolsControllerOptions['openPath']
  private readonly sessions: ToolsControllerOptions['sessions']
  private readonly resources: Array<() => void>
  private binding: ToolsSessionBinding | undefined
  private bindingDispose: (() => void) | undefined
  private confirmationPath: string | undefined
  private disposed = false
  private opening = false
  private publishPending = false
  private selectedCallId: string | undefined
  private status = ''

  constructor(options: ToolsControllerOptions) {
    this.openPath = options.openPath
    this.sessions = options.sessions
    this.resources = [options.sessions.list.subscribe(() => { this.rebind() })]
    this.rebind(false)
  }

  dispose(): void {
    this.disposed = true
    this.bindingDispose?.()
    this.bindingDispose = undefined
    for (const dispose of this.resources.splice(0).toReversed()) dispose()
    this.listeners.clear()
  }

  getSnapshot(): ToolsSnapshotView {
    const list = this.sessions.list.getSnapshot()
    const snapshot = this.binding?.getSnapshot()
    const flattened = flattenTools(toolsOf(snapshot), this.collapsed)
    const selected = this.ensureSelection(flattened)
    const rows = flattened.map(({ depth, presentation }): ToolInspectorRow => Object.freeze({
      callId: presentation.callId,
      depth,
      expandable: presentation.children.length > 0,
      expanded: presentation.children.length > 0 && !this.collapsed.has(presentation.callId),
      name: presentation.name,
      state: presentation.state,
      summary: presentation.summary,
      title: presentation.title,
    }))
    const current = list.current
    const title = current === undefined
      ? EMPTY_TITLE
      : sanitizeText(list.byId[current]?.displayTitle ?? String(current))
    if (this.confirmationPath !== undefined
      && (selected === undefined || !selected.presentation.paths.includes(this.confirmationPath))) {
      this.clearConfirmation()
    }
    return Object.freeze({
      confirmationPath: this.confirmationPath,
      details: selected?.presentation.details ?? '',
      phase: rows.length === 0 ? 'empty' : 'ready',
      rows: Object.freeze(rows),
      selectedCallId: selected?.presentation.callId,
      status: this.status,
      title,
    })
  }

  move(delta: number): void {
    if (!Number.isFinite(delta) || delta === 0) return
    const rows = flattenTools(toolsOf(this.binding?.getSnapshot()), this.collapsed)
    if (rows.length === 0) return
    const currentIndex = rows.findIndex(row => row.presentation.callId === this.selectedCallId)
    const start = Math.max(0, currentIndex)
    const direction = delta < 0 ? -1 : 1
    const next = rows[(start + direction + rows.length) % rows.length]
    if (next === undefined) return
    this.selectedCallId = next.presentation.callId
    this.clearConfirmation()
    this.schedulePublish()
  }

  async openSelected(): Promise<boolean> {
    if (this.opening) return false
    const rows = flattenTools(toolsOf(this.binding?.getSnapshot()), this.collapsed)
    const selected = rows.find(row => row.presentation.callId === this.selectedCallId) ?? rows[0]
    this.selectedCallId = selected?.presentation.callId
    const path = selected?.presentation.paths[0]
    if (path === undefined) {
      this.status = NO_PATH_COPY
      this.clearConfirmation(false)
      this.schedulePublish()
      return false
    }
    if (this.openPath === undefined) {
      this.status = OPEN_UNAVAILABLE_COPY
      this.clearConfirmation(false)
      this.schedulePublish()
      return false
    }
    if (this.confirmationPath !== path) {
      this.confirmationPath = path
      this.status = `${CONFIRM_OPEN_COPY}${STATUS_SEPARATOR}${path}`
      this.schedulePublish()
      return false
    }
    this.opening = true
    this.clearConfirmation(false)
    try {
      await this.openPath(path)
      this.status = `${OPENED_PREFIX}${STATUS_SEPARATOR}${path}`
      return true
    } catch (error) {
      this.status = `${OPEN_FAILED_PREFIX}${STATUS_SEPARATOR}${errorText(error)}`
      return false
    } finally {
      this.opening = false
      this.schedulePublish()
    }
  }

  select(callId: string): void {
    const rows = flattenTools(toolsOf(this.binding?.getSnapshot()), this.collapsed)
    if (!rows.some(row => row.presentation.callId === callId)) return
    this.selectedCallId = callId
    this.clearConfirmation()
    this.schedulePublish()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  toggleSelected(): void {
    const selected = flattenTools(toolsOf(this.binding?.getSnapshot()), this.collapsed)
      .find(row => row.presentation.callId === this.selectedCallId)
    if (selected === undefined || selected.presentation.children.length === 0) return
    if (this.collapsed.has(selected.presentation.callId)) this.collapsed.delete(selected.presentation.callId)
    else this.collapsed.add(selected.presentation.callId)
    this.clearConfirmation()
    this.schedulePublish()
  }

  private clearConfirmation(clearStatus = true): void {
    this.confirmationPath = undefined
    if (clearStatus) this.status = ''
  }

  private ensureSelection(rows: readonly FlattenedTool[]): FlattenedTool | undefined {
    const selected = rows.find(row => row.presentation.callId === this.selectedCallId) ?? rows[0]
    this.selectedCallId = selected?.presentation.callId
    return selected
  }

  private rebind(publish = true): void {
    this.bindingDispose?.()
    const current = this.sessions.list.getSnapshot().current
    this.binding = current === undefined ? undefined : this.sessions.binding(current)
    this.bindingDispose = this.binding?.subscribe(() => { this.schedulePublish() })
    this.selectedCallId = undefined
    this.clearConfirmation()
    this.collapsed.clear()
    if (publish) this.schedulePublish()
  }

  private schedulePublish(): void {
    if (this.publishPending || this.disposed) return
    this.publishPending = true
    queueMicrotask(() => {
      this.publishPending = false
      if (this.disposed) return
      for (const listener of this.listeners) listener()
    })
  }
}

export function createToolsController(options: ToolsControllerOptions): ToolsController {
  return new ToolsControllerService(options)
}
