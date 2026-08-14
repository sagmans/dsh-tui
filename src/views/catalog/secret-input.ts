import {
  InputRenderable,
  type InputRenderableOptions,
  type PasteEvent,
  type RenderContext,
} from '@opentui/core'

const MASK_CHARACTER = '•'
const LINE_BREAKS = /[\r\n]/gu
const PASTE_DECODER = new TextDecoder()

type SecretInputOptions = Omit<InputRenderableOptions, 'onContentChange' | 'value'> & {
  readonly onSecretChange: (value: string) => void
}

/**
 * Keeps credentials outside OpenTUI's render and selection buffers so terminal capture cannot recover them.
 */
export class SecretInputRenderable extends InputRenderable {
  private readonly onSecretChange: (value: string) => void
  private secret: string[] = []

  constructor(ctx: RenderContext, options: SecretInputOptions) {
    const { onSecretChange, ...inputOptions } = options
    super(ctx, { ...inputOptions, value: '' })
    this.onSecretChange = onSecretChange
  }

  get secretValue(): string {
    return this.secret.join('')
  }

  override insertText(text: string): void {
    const normalized = Array.from(text.replace(LINE_BREAKS, ''))
    if (normalized.length === 0) return
    const selection = this.getSelection()
    const start = selection?.start ?? this.cursorOffset
    const removed = selection === null ? 0 : selection.end - selection.start
    const beforeLength = this.plainText.length
    super.insertText(normalized.map(() => MASK_CHARACTER).join(''))
    const inserted = this.plainText.length - (beforeLength - removed)
    if (inserted <= 0) return
    this.secret.splice(start, removed, ...normalized.slice(0, inserted))
    this.publishSecret()
  }

  override handlePaste(event: PasteEvent): void {
    this.insertText(PASTE_DECODER.decode(event.bytes))
  }

  override deleteCharBackward(): boolean {
    return this.deleteBackward(() => super.deleteCharBackward())
  }

  override deleteChar(): boolean {
    return this.deleteForward(() => super.deleteChar())
  }

  override deleteLine(): boolean {
    const changed = super.deleteLine()
    if (changed) {
      this.secret = []
      this.publishSecret()
    }
    return changed
  }

  override deleteWordBackward(): boolean {
    return this.deleteBackward(() => super.deleteWordBackward())
  }

  override deleteWordForward(): boolean {
    return this.deleteForward(() => super.deleteWordForward())
  }

  override deleteToLineStart(): boolean {
    return this.deleteBackward(() => super.deleteToLineStart())
  }

  override deleteToLineEnd(): boolean {
    return this.deleteForward(() => super.deleteToLineEnd())
  }

  override deleteCharacter(direction: 'backward' | 'forward'): void {
    if (direction === 'backward') this.deleteCharBackward()
    else this.deleteChar()
  }

  override undo(): boolean {
    return false
  }

  override redo(): boolean {
    return false
  }

  private deleteBackward(operation: () => boolean): boolean {
    const beforeLength = this.plainText.length
    const selection = this.getSelection()
    const cursor = this.cursorOffset
    const changed = operation()
    if (!changed) return false
    const removed = beforeLength - this.plainText.length
    const start = selection?.start ?? Math.max(0, cursor - removed)
    this.secret.splice(start, removed)
    this.publishSecret()
    return true
  }

  private deleteForward(operation: () => boolean): boolean {
    const beforeLength = this.plainText.length
    const selection = this.getSelection()
    const cursor = this.cursorOffset
    const changed = operation()
    if (!changed) return false
    const removed = beforeLength - this.plainText.length
    this.secret.splice(selection?.start ?? cursor, removed)
    this.publishSecret()
    return true
  }

  private publishSecret(): void {
    this.onSecretChange(this.secretValue)
  }
}
