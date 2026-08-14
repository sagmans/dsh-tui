import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ConversationController,
  ConversationControllerOptions,
  ConversationPhase,
  ConversationSendMode,
  ConversationSessionBinding,
  ConversationSnapshotView,
} from './contracts.js'
import {
  projectConversationLines,
  projectQueuedLines,
  sanitizeConversationText,
} from './projection.js'
import { sanitizeText } from '../sessions/projection.js'

export type * from './contracts.js'

const EMPTY_TITLE = 'NO SESSION'
const EMPTY_STATUS = 'Open Sessions with gs or mouse.'
const COMMAND_PREFIX = '/'
const DEFAULT_SEND_MODE: ConversationSendMode = 'queue'
const SCROLL_STEP = 12
const MAX_VISIBLE_LINES = 240
const COMPLETION_SUFFIX = ' '
const COMPLETION_LIMIT = 8
const WHITESPACE_PATTERN = /\s/u

function phaseOf(snapshot: ConversationSnapshot | undefined): ConversationPhase {
  if (snapshot === undefined) return 'empty'
  switch (snapshot.openState) {
    case 'cold':
    case 'loading': return 'loading'
    case 'error': return 'error'
    case 'open': return 'ready'
    default: {
      const exhaustive: never = snapshot.openState
      throw new Error(`unhandled conversation open state: ${String(exhaustive)}`)
    }
  }
}

function statusOf(snapshot: ConversationSnapshot | undefined): string {
  if (snapshot === undefined) return EMPTY_STATUS
  if (snapshot.openState === 'loading' || snapshot.openState === 'cold') return 'Loading history…'
  if (snapshot.openState === 'error') return 'History unavailable.'
  if (snapshot.removed) return 'Session removed · read only'
  if (snapshot.pending.length > 0) return `${snapshot.pending.length} interaction${snapshot.pending.length === 1 ? '' : 's'} waiting`
  if (snapshot.queue.length > 0) return `${snapshot.queue.length} queued · Ctrl+Enter steers`
  if (snapshot.running) return 'Running · Ctrl+X stop · Ctrl+Enter steer'
  if (snapshot.loadingOlder) return 'Loading older history…'
  if (snapshot.hasMore) return 'Older history available · PageUp'
  return 'Ready'
}

function snapshotError(snapshot: ConversationSnapshot | undefined): string | undefined {
  if (snapshot === undefined) return undefined
  if (snapshot.openError !== null) return sanitizeText(snapshot.openError.message)
  if (snapshot.promptError !== null) return sanitizeText(snapshot.promptError.error.message)
  if (snapshot.lastAgentError !== null) return sanitizeText(snapshot.lastAgentError)
  return undefined
}

function visibleLines(snapshot: ConversationSnapshot, offset: number) {
  const durable = snapshot.views.get('tui')?.lines ?? projectConversationLines({
    nodes: snapshot.nodes,
    partial: snapshot.partial,
    runningCalls: snapshot.runningCalls,
  })
  const lines = [...durable, ...projectQueuedLines(snapshot.queue)]
  const end = Math.max(0, lines.length - offset)
  const start = Math.max(0, end - MAX_VISIBLE_LINES)
  return Object.freeze(lines.slice(start, end))
}

class ConversationControllerService implements ConversationController {
  private readonly completion: ConversationControllerOptions['completion']
  private readonly listeners = new Set<() => void>()
  private readonly sessions: ConversationControllerOptions['sessions']
  private readonly resources: Array<() => void>
  private readonly drafts = new Map<string, string>()
  private binding: ConversationSessionBinding | undefined
  private bindingDispose: (() => void) | undefined
  private completionRevision = 0
  private disposed = false
  private error: string | undefined
  private offset = 0
  private publishPending = false
  private suggestions: readonly string[] = []

  constructor(options: ConversationControllerOptions) {
    this.completion = options.completion
    this.sessions = options.sessions
    this.resources = [options.sessions.list.subscribe(() => { this.rebind() })]
    this.rebind(false)
  }

  async cancel(): Promise<void> {
    const binding = this.binding
    if (binding === undefined) return
    await this.runAction(() => binding.cancel())
  }

  async complete(): Promise<void> {
    const completion = this.completion
    const sessionId = this.sessions.list.getSnapshot().current
    const draft = this.currentDraft().trimStart()
    if (completion === undefined || sessionId === undefined || !draft.startsWith(COMMAND_PREFIX)) return
    const token = draft.slice(COMMAND_PREFIX.length)
    if (WHITESPACE_PATTERN.test(token)) return
    const revision = ++this.completionRevision
    const candidates = await this.runValue(() => completion.complete(sessionId, token))
    if (candidates === undefined || revision !== this.completionRevision) return
    const current = this.sessions.list.getSnapshot().current
    if (current !== sessionId || this.currentDraft().trimStart() !== draft) return
    const suggestions = Object.freeze([...new Set(candidates.map(candidate => sanitizeText(candidate)))].slice(0, COMPLETION_LIMIT))
    const selected = suggestions[0]
    if (selected !== undefined) this.setDraft(`${COMMAND_PREFIX}${selected}${COMPLETION_SUFFIX}`)
    this.suggestions = suggestions
    this.schedulePublish()
  }

  dispose(): void {
    this.disposed = true
    this.bindingDispose?.()
    this.bindingDispose = undefined
    for (const dispose of this.resources.splice(0).toReversed()) dispose()
    this.listeners.clear()
  }

  getSnapshot(): ConversationSnapshotView {
    const list = this.sessions.list.getSnapshot()
    const sessionId = list.current
    const snapshot = this.binding?.getSnapshot()
    const phase = phaseOf(snapshot)
    const title = sessionId === undefined
      ? EMPTY_TITLE
      : sanitizeText(list.byId[sessionId]?.displayTitle ?? String(sessionId))
    return Object.freeze({
      draft: this.currentDraft(),
      error: this.error ?? snapshotError(snapshot),
      hasMore: snapshot?.hasMore ?? false,
      lines: snapshot === undefined ? Object.freeze([]) : visibleLines(snapshot, this.offset),
      loadingOlder: snapshot?.loadingOlder ?? false,
      phase,
      running: snapshot?.running ?? false,
      sessionId,
      status: statusOf(snapshot),
      suggestions: this.suggestions,
      title,
    })
  }

  async loadOlder(): Promise<void> {
    const binding = this.binding
    if (binding === undefined) return
    await this.runAction(() => binding.loadOlder())
  }

  scroll(delta: number): void {
    if (!Number.isFinite(delta) || delta === 0) return
    this.offset = Math.max(0, this.offset + (delta < 0 ? SCROLL_STEP : -SCROLL_STEP))
    this.schedulePublish()
  }

  scrollOffset(): number {
    return this.offset
  }

  send(text: string, mode: ConversationSendMode = DEFAULT_SEND_MODE): Promise<boolean> {
    this.setDraft(text)
    return this.sendDraft(mode)
  }

  async sendDraft(mode: ConversationSendMode = DEFAULT_SEND_MODE): Promise<boolean> {
    const binding = this.binding
    if (binding === undefined) return false
    const submittedDraft = this.currentDraft()
    const normalized = sanitizeConversationText(submittedDraft).trim()
    if (normalized === '') return false
    this.setDraft('')
    this.suggestions = []
    this.schedulePublish()
    const sent = await this.runAction(async () => {
      if (!normalized.startsWith(COMMAND_PREFIX)) {
        await binding.prompt(normalized, mode)
        return
      }
      const matched = await binding.command(normalized)
      if (!matched) await binding.prompt(normalized, mode)
    })
    if (!sent && this.currentDraft() === '') this.setDraft(submittedDraft)
    if (sent) this.offset = 0
    this.schedulePublish()
    return sent
  }

  setDraft(text: string): void {
    const current = this.sessions.list.getSnapshot().current
    if (current === undefined) return
    this.drafts.set(String(current), text)
    this.suggestions = []
    this.completionRevision++
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private currentDraft(): string {
    const current = this.sessions.list.getSnapshot().current
    return current === undefined ? '' : this.drafts.get(String(current)) ?? ''
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

  private rebind(publish = true): void {
    this.bindingDispose?.()
    const current = this.sessions.list.getSnapshot().current
    this.binding = current === undefined ? undefined : this.sessions.binding(current)
    this.bindingDispose = this.binding?.subscribe(() => { this.schedulePublish() })
    this.error = undefined
    this.offset = 0
    this.suggestions = []
    this.completionRevision++
    if (publish) this.schedulePublish()
  }

  private async runAction(action: () => Promise<void>): Promise<boolean> {
    try {
      await action()
      this.error = undefined
      this.schedulePublish()
      return true
    } catch (error) {
      this.error = sanitizeText(error instanceof Error ? error.message : String(error))
      this.schedulePublish()
      return false
    }
  }

  private async runValue<T>(action: () => Promise<T>): Promise<T | undefined> {
    try {
      const value = await action()
      this.error = undefined
      return value
    } catch (error) {
      this.error = sanitizeText(error instanceof Error ? error.message : String(error))
      this.schedulePublish()
      return undefined
    }
  }
}

export function createConversationController(options: ConversationControllerOptions): ConversationController {
  return new ConversationControllerService(options)
}
