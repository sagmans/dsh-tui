import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ConversationAttachmentView,
  ConversationControllerOptions,
  ConversationInputKind,
  ConversationInputView,
  ConversationLoadedImage,
} from './contracts.js'
import { sanitizeText } from '../sessions/projection.js'

const MAX_DRAFT_IMAGES = 20
const ATTACHMENT_TITLE = 'ATTACH IMAGE'
const ATTACHMENT_PLACEHOLDER = 'Absolute local image path'
const EXPORT_TITLE = 'EXPORT SESSION'
const EXPORT_PLACEHOLDER = 'Absolute new .zip destination'
const ATTACHMENT_LIMIT_ERROR = `At most ${MAX_DRAFT_IMAGES} images can be staged.`
const EXPORT_COMPLETE = 'Session archive exported.'

interface ConversationMediaStateOptions {
  readonly blocked: () => boolean
  readonly currentSession: () => SessionId | undefined
  readonly media: ConversationControllerOptions['media']
  readonly publish: () => void
  readonly setError: (error: string | undefined) => void
  readonly setNotice: (notice: string | undefined) => void
}

function inputView(kind: ConversationInputKind, value: string): ConversationInputView {
  switch (kind) {
    case 'attachment': return Object.freeze({
      kind,
      placeholder: ATTACHMENT_PLACEHOLDER,
      title: ATTACHMENT_TITLE,
      value,
    })
    case 'export': return Object.freeze({
      kind,
      placeholder: EXPORT_PLACEHOLDER,
      title: EXPORT_TITLE,
      value,
    })
    default: {
      const exhaustive: never = kind
      throw new Error(`unhandled conversation input: ${String(exhaustive)}`)
    }
  }
}

export class ConversationMediaState {
  private readonly attachments = new Map<string, ConversationLoadedImage[]>()
  private readonly options: ConversationMediaStateOptions
  private abort: AbortController | undefined
  private busyCount = 0
  private disposed = false
  private inputKind: ConversationInputKind | undefined
  private inputValue = ''
  private revision = 0

  constructor(options: ConversationMediaStateOptions) {
    this.options = options
  }

  get busy(): boolean {
    return this.busyCount > 0
  }

  beginAttachment(): void {
    const sessionId = this.options.currentSession()
    if (!this.available(sessionId)) return
    if (this.attachmentsFor(sessionId).length >= MAX_DRAFT_IMAGES) {
      this.options.setError(ATTACHMENT_LIMIT_ERROR)
      this.options.publish()
      return
    }
    this.beginInput('attachment')
  }

  beginExport(): void {
    const sessionId = this.options.currentSession()
    if (!this.available(sessionId)) return
    this.beginInput('export')
  }

  cancelInput(): void {
    if (this.inputKind === undefined) return
    this.inputKind = undefined
    this.inputValue = ''
    this.options.publish()
  }

  clearAttachments(): void {
    const current = this.options.currentSession()
    if (current === undefined || !this.attachments.delete(String(current))) return
    this.options.publish()
  }

  dispose(): void {
    this.disposed = true
    this.resetTransient()
  }

  input(): ConversationInputView | undefined {
    return this.inputKind === undefined ? undefined : inputView(this.inputKind, this.inputValue)
  }

  removeAttachment(index: number): void {
    const current = this.options.currentSession()
    if (current === undefined || !Number.isInteger(index)) return
    const attachments = this.attachmentsFor(current)
    if (index < 0 || index >= attachments.length) return
    attachments.splice(index, 1)
    this.options.publish()
  }

  removeSent(sessionId: SessionId, sent: readonly ConversationLoadedImage[]): void {
    const current = this.attachments.get(String(sessionId))
    if (current === undefined) return
    const sentSet = new Set(sent)
    this.attachments.set(String(sessionId), current.filter(image => !sentSet.has(image)))
  }

  resetTransient(): void {
    this.abort?.abort()
    this.abort = undefined
    this.revision++
    this.inputKind = undefined
    this.inputValue = ''
  }

  setInput(value: string): void {
    if (this.inputKind === undefined) return
    this.inputValue = sanitizeText(value)
  }

  staged(sessionId: SessionId): readonly ConversationLoadedImage[] {
    return this.attachmentsFor(sessionId)
  }

  views(sessionId: SessionId | undefined): readonly ConversationAttachmentView[] {
    return sessionId === undefined
      ? Object.freeze([])
      : Object.freeze(this.attachmentsFor(sessionId).map(item => item.view))
  }

  async submitInput(): Promise<boolean> {
    const media = this.options.media
    const sessionId = this.options.currentSession()
    const kind = this.inputKind
    const path = this.inputValue.trim()
    if (media === undefined || sessionId === undefined || kind === undefined || path === '') return false
    this.inputKind = undefined
    this.inputValue = ''
    this.abort?.abort()
    const abort = new AbortController()
    this.abort = abort
    const revision = ++this.revision
    this.busyCount += 1
    this.options.setError(undefined)
    this.options.setNotice(undefined)
    this.options.publish()
    try {
      await this.execute(kind, media, sessionId, path, abort.signal, revision)
      return this.accept(sessionId, revision, abort.signal)
    } catch (error) {
      if (!abort.signal.aborted) {
        this.options.setError(sanitizeText(error instanceof Error ? error.message : String(error)))
      }
      return false
    } finally {
      this.busyCount = Math.max(0, this.busyCount - 1)
      if (this.abort === abort) this.abort = undefined
      this.options.publish()
    }
  }

  private accept(sessionId: SessionId, revision: number, signal: AbortSignal): boolean {
    return !this.disposed
      && !signal.aborted
      && revision === this.revision
      && this.options.currentSession() === sessionId
  }

  private attachmentsFor(sessionId: SessionId): ConversationLoadedImage[] {
    const key = String(sessionId)
    const existing = this.attachments.get(key)
    if (existing !== undefined) return existing
    const created: ConversationLoadedImage[] = []
    this.attachments.set(key, created)
    return created
  }

  private available(sessionId: SessionId | undefined): sessionId is SessionId {
    return this.options.media !== undefined
      && sessionId !== undefined
      && !this.busy
      && !this.options.blocked()
  }

  private beginInput(kind: ConversationInputKind): void {
    this.inputKind = kind
    this.inputValue = ''
    this.options.setError(undefined)
    this.options.setNotice(undefined)
    this.options.publish()
  }

  private async execute(
    kind: ConversationInputKind,
    media: NonNullable<ConversationControllerOptions['media']>,
    sessionId: SessionId,
    path: string,
    signal: AbortSignal,
    revision: number,
  ): Promise<void> {
    switch (kind) {
      case 'attachment': {
        const image = await media.loadImage(path, signal)
        if (!this.accept(sessionId, revision, signal)) return
        const attachments = this.attachmentsFor(sessionId)
        if (attachments.length >= MAX_DRAFT_IMAGES) throw new Error(ATTACHMENT_LIMIT_ERROR)
        attachments.push(image)
        return
      }
      case 'export':
        await media.exportSession(sessionId, path, signal)
        if (this.accept(sessionId, revision, signal)) this.options.setNotice(EXPORT_COMPLETE)
        return
      default: {
        const exhaustive: never = kind
        throw new Error(`unhandled conversation input submission: ${String(exhaustive)}`)
      }
    }
  }
}
