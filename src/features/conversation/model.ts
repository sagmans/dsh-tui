import type { PromptContentPart, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ConversationController,
  ConversationControllerOptions,
  ConversationModelSelectionEntry,
  ConversationPreferenceSection,
  ConversationSendMode,
  ConversationSessionBinding,
  ConversationSnapshotView,
} from './contracts.js'
import { ConversationMediaState } from './media.js'
import { sanitizeConversationText } from './projection.js'
import type { InputTriggerMutation, InputTriggerSource } from '../input-trigger/contracts.js'
import {
  conversationError,
  conversationPhase,
  conversationStatus,
  visibleConversationLines,
} from './snapshot.js'
import { sanitizeText } from '../sessions/projection.js'

export type * from './contracts.js'

const EMPTY_TITLE = 'NO SESSION'
const COMMAND_PREFIX = '/'
const MODEL_COMMAND = '/model'
const MODEL_UNROUTABLE_ERROR = 'No provider can route the current model. Open model selection to configure a provider.'
const TRIGGER_COMMAND_MISS_ERROR = 'Selected command is no longer available.'
const DEFAULT_SEND_MODE: ConversationSendMode = 'queue'
const SCROLL_STEP = 12
const COMPLETION_SUFFIX = ' '
const COMPLETION_LIMIT = 8
const WHITESPACE_PATTERN = /\s/u

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function accessPresetOf(values: Readonly<Record<string, unknown>> | undefined): string | undefined {
  const permissions = values?.permissions
  if (!record(permissions)) return undefined
  return typeof permissions.currentValue === 'string' ? sanitizeText(permissions.currentValue) : undefined
}

class ConversationControllerService implements ConversationController {
  private readonly completion: ConversationControllerOptions['completion']
  private readonly listeners = new Set<() => void>()
  private readonly mediaState: ConversationMediaState
  private readonly models: ConversationControllerOptions['models']
  private readonly openSettings: ConversationControllerOptions['openSettings']
  private readonly sessions: ConversationControllerOptions['sessions']
  private readonly triggers: ConversationControllerOptions['triggers']
  private readonly resources: Array<() => void>
  private readonly carets = new Map<string, number>()
  private readonly drafts = new Map<string, string>()
  private binding: ConversationSessionBinding | undefined
  private bindingDispose: (() => void) | undefined
  private boundSessionId: SessionId | undefined
  private completionRevision = 0
  private disposed = false
  private error: string | undefined
  private notice: string | undefined
  private offset = 0
  private publishPending = false
  private sending = false
  private suggestions: readonly string[] = []

  constructor(options: ConversationControllerOptions) {
    this.completion = options.completion
    this.models = options.models
    this.openSettings = options.openSettings
    this.sessions = options.sessions
    this.triggers = options.triggers
    this.mediaState = new ConversationMediaState({
      blocked: () => this.sending,
      currentSession: () => this.sessions.list.getSnapshot().current,
      media: options.media,
      publish: () => { this.schedulePublish() },
      setError: error => { this.error = error },
      setNotice: notice => { this.notice = notice },
    })
    this.resources = [options.sessions.list.subscribe(() => { this.rebind() })]
    if (options.models !== undefined) {
      this.resources.push(options.models.subscribe(() => { this.schedulePublish() }))
    }
    if (options.triggers !== undefined) {
      this.resources.push(options.triggers.subscribe(() => { this.schedulePublish() }))
    }
    this.rebind(false)
  }

  beginAttachment(): void {
    this.triggers?.dismiss()
    this.mediaState.beginAttachment()
  }

  beginExport(): void {
    this.triggers?.dismiss()
    this.mediaState.beginExport()
  }

  async cancel(): Promise<void> {
    const binding = this.binding
    if (binding === undefined) return
    await this.runAction(() => binding.cancel())
  }

  cancelInput(): void {
    this.mediaState.cancelInput()
  }

  clearAttachments(): void {
    this.mediaState.clearAttachments()
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

  dismissTrigger(): void {
    this.triggers?.dismiss()
  }

  dispose(): void {
    this.disposed = true
    this.mediaState.dispose()
    this.triggers?.dismiss()
    this.bindingDispose?.()
    this.bindingDispose = undefined
    for (const dispose of this.resources.splice(0).toReversed()) dispose()
    this.listeners.clear()
  }

  getSnapshot(): ConversationSnapshotView {
    const list = this.sessions.list.getSnapshot()
    const sessionId = list.current
    const snapshot = this.binding?.getSnapshot()
    const phase = conversationPhase(snapshot)
    const summary = sessionId === undefined ? undefined : list.byId[sessionId]
    const model = this.models?.getSnapshot()
    const modelAvailable = sessionId !== undefined && model?.available === true
    const title = sessionId === undefined
      ? EMPTY_TITLE
      : sanitizeText(summary?.displayTitle ?? String(sessionId))
    return Object.freeze({
      accessPreset: accessPresetOf(summary?.projectionValues),
      agentPreset: summary?.agentPreset === undefined ? undefined : sanitizeText(summary.agentPreset),
      attachments: this.mediaState.views(sessionId),
      busy: this.mediaState.busy || this.sending,
      draft: this.currentDraft(),
      error: this.error ?? conversationError(snapshot),
      hasMore: snapshot?.hasMore ?? false,
      input: this.mediaState.input(),
      lines: snapshot === undefined ? Object.freeze([]) : visibleConversationLines(snapshot, this.offset),
      loadingOlder: snapshot?.loadingOlder ?? false,
      modelAvailable,
      modelEffort: modelAvailable ? model.effortLabel : undefined,
      modelLabel: modelAvailable ? model.currentLabel : undefined,
      modelRoutable: modelAvailable ? model.routable : undefined,
      phase,
      running: snapshot?.running ?? false,
      sessionId,
      status: this.notice ?? conversationStatus(snapshot),
      suggestions: this.suggestions,
      title,
      trigger: sessionId === undefined ? undefined : this.triggers?.getSnapshot(),
    })
  }

  launchTrigger(): void {
    const sessionId = this.sessions.list.getSnapshot().current
    if (sessionId === undefined) return
    const draft = this.currentDraft()
    const caret = this.carets.get(String(sessionId)) ?? draft.length
    this.triggers?.launch(sessionId, draft, caret)
  }

  async loadOlder(): Promise<void> {
    const binding = this.binding
    if (binding === undefined) return
    await this.runAction(() => binding.loadOlder())
  }

  moveTrigger(delta: number): void {
    this.triggers?.move(delta)
  }

  openModelSelection(entry: ConversationModelSelectionEntry): void {
    if (this.models?.getSnapshot().available !== true) return
    void this.runValue(() => this.models?.open(entry) ?? Promise.resolve(false))
  }

  openPreferences(section: ConversationPreferenceSection): void {
    this.openSettings?.(section)
  }

  pickTrigger(source: InputTriggerSource, index: number): void {
    this.applyTriggerMutation(this.triggers?.pick(source, index))
  }

  pickTriggerHighlight(): void {
    this.applyTriggerMutation(this.triggers?.pickHighlighted())
  }

  removeAttachment(index: number): void {
    this.mediaState.removeAttachment(index)
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
    if (this.sending) return false
    const binding = this.binding
    const sessionId = this.sessions.list.getSnapshot().current
    if (binding === undefined || sessionId === undefined) return false
    const submittedDraft = this.currentDraft()
    const normalized = sanitizeConversationText(submittedDraft).trim()
    const submittedImages = [...this.mediaState.staged(sessionId)]
    if (normalized === '' && submittedImages.length === 0) return false
    const model = this.models?.getSnapshot()
    if (submittedImages.length === 0 && normalized === MODEL_COMMAND && model?.available === true) {
      const opened = await this.runValue(() => this.models?.open('command') ?? Promise.resolve(false))
      if (opened !== true) return false
      this.setDraft('')
      this.schedulePublish()
      return true
    }
    if (model?.available === true && model.routable === false) {
      this.error = MODEL_UNROUTABLE_ERROR
      this.schedulePublish()
      return false
    }
    this.setDraft('')
    this.notice = undefined
    this.suggestions = []
    this.sending = true
    this.schedulePublish()
    const sent = await this.runAction(async () => {
      if (submittedImages.length === 0 && normalized.startsWith(COMMAND_PREFIX)) {
        const matched = await binding.command(normalized)
        if (matched) return
      }
      const content: PromptContentPart[] = []
      const serialized = normalized === '' || this.triggers === undefined
        ? normalized
        : await this.triggers.serialize(sessionId, normalized, new AbortController().signal)
      if (serialized !== '') content.push({ type: 'text', text: serialized })
      content.push(...submittedImages.map(image => image.content))
      await binding.prompt(content, mode)
    })
    this.sending = false
    const sessionKey = String(sessionId)
    if (!sent && (this.drafts.get(sessionKey) ?? '') === '') {
      this.drafts.set(sessionKey, submittedDraft)
      this.carets.set(sessionKey, submittedDraft.length)
    }
    if (sent) {
      this.offset = 0
      this.mediaState.removeSent(sessionId, submittedImages)
    }
    this.schedulePublish()
    return sent
  }

  setDraft(text: string, caret = text.length): void {
    const current = this.sessions.list.getSnapshot().current
    if (current === undefined) return
    const sessionKey = String(current)
    this.drafts.set(sessionKey, text)
    this.carets.set(sessionKey, Math.max(0, Math.min(caret, text.length)))
    this.notice = undefined
    this.suggestions = []
    this.completionRevision++
    this.triggers?.track(current, text, caret)
  }

  setInput(value: string): void {
    this.mediaState.setInput(value)
  }

  submitInput(): Promise<boolean> {
    return this.mediaState.submitInput()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private applyTriggerMutation(mutation: InputTriggerMutation | undefined): void {
    if (mutation === undefined) return
    const draft = this.currentDraft()
    if (mutation.start < 0 || mutation.end < mutation.start || mutation.end > draft.length) return
    const inserted = mutation.submit ? '' : mutation.text
    const next = `${draft.slice(0, mutation.start)}${inserted}${draft.slice(mutation.end)}`
    this.setDraft(next, mutation.start + inserted.length)
    this.schedulePublish()
    if (mutation.submit) this.executeTriggerCommand(mutation.text)
  }

  private currentDraft(): string {
    const current = this.sessions.list.getSnapshot().current
    return current === undefined ? '' : this.drafts.get(String(current)) ?? ''
  }

  private executeTriggerCommand(command: string): void {
    if (command === MODEL_COMMAND) {
      this.openModelSelection('command')
      return
    }
    const binding = this.binding
    if (binding === undefined) return
    void this.runAction(async () => {
      if (!await binding.command(command)) throw new Error(TRIGGER_COMMAND_MISS_ERROR)
    })
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
    const current = this.sessions.list.getSnapshot().current
    if (current === this.boundSessionId) {
      if (publish) this.schedulePublish()
      return
    }
    this.boundSessionId = current
    this.mediaState.resetTransient()
    this.triggers?.dismiss()
    this.bindingDispose?.()
    this.binding = current === undefined ? undefined : this.sessions.binding(current)
    this.bindingDispose = this.binding?.subscribe(() => { this.schedulePublish() })
    this.error = undefined
    this.notice = undefined
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
