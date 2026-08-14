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
  private readonly sessions: ToolsControllerOptions['sessions']
  private readonly resources: Array<() => void>
  private binding: ToolsSessionBinding | undefined
  private bindingDispose: (() => void) | undefined
  private disposed = false
  private publishPending = false
  private selectedCallId: string | undefined

  constructor(options: ToolsControllerOptions) {
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
    return Object.freeze({
      details: selected?.presentation.details ?? '',
      phase: rows.length === 0 ? 'empty' : 'ready',
      rows: Object.freeze(rows),
      selectedCallId: selected?.presentation.callId,
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
    this.schedulePublish()
  }

  select(callId: string): void {
    const rows = flattenTools(toolsOf(this.binding?.getSnapshot()), this.collapsed)
    if (!rows.some(row => row.presentation.callId === callId)) return
    this.selectedCallId = callId
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
    this.schedulePublish()
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
