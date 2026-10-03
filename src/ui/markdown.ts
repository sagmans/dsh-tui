import { Markdown, wrapTextWithAnsi, type DefaultTextStyle, type MarkdownOptions, type MarkdownTheme } from '@earendil-works/pi-tui'
import { displayText } from '../text.ts'
import type { MermaidTransform } from './mermaid.ts'

/** Bound retained parses so redraw reuse does not grow memory with the entire transcript; reuse refreshes eviction order. */
export const MARKDOWN_CACHE_LIMIT = 64
const STACK_OVERFLOW_MESSAGE = 'Maximum call stack size exceeded'

/**
 * How a row is based where the markdown itself has no rule for the text.
 *
 * Two rows can carry identical words and still have to draw differently — a
 * prompt repeated as a reply, a thought quoted in an answer — and a parse is
 * cached with the lines it drew, so the face is part of what identifies a parse
 * rather than a detail of one drawing.
 */
export interface MarkdownFace {
  /** Names the face in the parse cache; two faces never share a parse. */
  readonly name: string
  /** The shade text keeps where the markdown has no rule for it. */
  readonly base?: DefaultTextStyle
  /** A theme of this face's own, for a row the answer's colours would outshine. */
  readonly theme?: MarkdownTheme
  /** Whether this face asks the renderer's transform for a drawing; a thought's does not. */
  readonly transform?: boolean
}

/** The face an answer is drawn in: the reader's markdown theme, drawings included. */
export const ANSWER_FACE: MarkdownFace = { name: 'answer' }

/**
 * Render one message as markdown without reparsing the whole history.
 *
 * A repaint walks every row, so parsing each message again on every keystroke
 * would make a long session crawl. Parsing is keyed by message text because
 * that is what changes; the component re-renders on its own when the width does.
 */
export class MarkdownRenderer {
  private readonly parsed = new Map<string, Markdown>()

  constructor(private readonly theme: MarkdownTheme, private readonly mermaid?: MermaidTransform) {}

  render(text: string, width: number, live = false, face: MarkdownFace = ANSWER_FACE): string[] {
    // A streaming reply can settle on the very text it last streamed, and the
    // two renderings are not the same: only a settled one may report what a
    // drawing lost, and a mode may draw one and withhold the other. The flag and
    // the face are part of a message's identity for the same reason the text is.
    const key = `${face.name}\u0000${live ? 'live' : 'settled'}\u0000${text}`
    let message = this.parsed.get(key)
    if (message === undefined) {
      if (this.parsed.size >= MARKDOWN_CACHE_LIMIT) {
        const oldest = this.parsed.keys().next()
        if (oldest.done !== true) this.parsed.delete(oldest.value)
      }
      message = new Markdown(text, 0, 0, face.theme ?? this.theme, face.base, this.options(face, live))
    } else {
      // Refresh eviction priority on reuse to favor recently rendered parses, not transcript positions.
      this.parsed.delete(key)
    }
    this.parsed.set(key, message)
    const availableWidth = Math.max(1, Math.floor(width))
    try {
      return message.render(availableWidth)
    } catch (error) {
      if (!(error instanceof RangeError) || error.message !== STACK_OVERFLOW_MESSAGE) throw error
      // Source remains inspectable when dependency layout exceeds the engine's argument or recursion limit.
      return wrapTextWithAnsi(displayText(text), availableWidth)
    }
  }

  /**
   * The parse options this renderer installs, absent when nothing transforms.
   *
   * The flag is captured rather than read per call: the component caches the
   * rows it drew, so the value that built it is the only one it could honour.
   * A face that refuses the transform keeps its fences as source, which is how a
   * diagram cannot take over a row that was meant to stay subordinate.
   */
  private options(face: MarkdownFace, live: boolean): MarkdownOptions | undefined {
    const mermaid = this.mermaid
    if (mermaid === undefined || face.transform === false) return undefined
    return { transform: (markdown, availableWidth) => mermaid(markdown, availableWidth, live) }
  }

  /**
   * Drop parsed messages after a theme change.
   *
   * A `Markdown` caches the lines it rendered for a width, so keeping the
   * instance would keep the old escapes; the reader's new shade would land
   * everywhere except the answer.
   */
  invalidate(): void {
    for (const message of this.parsed.values()) message.invalidate()
    this.parsed.clear()
  }
}
