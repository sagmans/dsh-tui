import { Markdown, type MarkdownOptions, type MarkdownTheme } from '@earendil-works/pi-tui'
import type { MermaidTransform } from './mermaid.ts'

/** Parsed messages kept for redraws; everything above this is cold transcript. */
export const MARKDOWN_CACHE_LIMIT = 64

/**
 * Render assistant text as markdown without reparsing the whole history.
 *
 * A repaint walks every row, so parsing each message again on every keystroke
 * would make a long session crawl. Parsing is keyed by message text because
 * that is what changes; the component re-renders on its own when the width does.
 */
export class MarkdownRenderer {
  private readonly parsed = new Map<string, Markdown>()

  constructor(private readonly theme: MarkdownTheme, private readonly mermaid?: MermaidTransform) {}

  render(text: string, width: number, live = false): string[] {
    // A streaming reply can settle on the very text it last streamed, and the
    // two renderings are not the same: only a settled one may report what a
    // drawing lost, and a mode may draw one and withhold the other. The flag is
    // part of a message's identity for the same reason the text is.
    const key = live ? `live\u0000${text}` : `settled\u0000${text}`
    let message = this.parsed.get(key)
    if (message === undefined) {
      if (this.parsed.size >= MARKDOWN_CACHE_LIMIT) {
        const oldest = this.parsed.keys().next()
        if (oldest.done !== true) this.parsed.delete(oldest.value)
      }
      message = new Markdown(text, 0, 0, this.theme, undefined, this.options(live))
    } else {
      // Reinserting keeps a message that is still on screen from ageing out.
      this.parsed.delete(key)
    }
    this.parsed.set(key, message)
    return message.render(Math.max(1, Math.floor(width)))
  }

  /**
   * The parse options this renderer installs, absent when nothing transforms.
   *
   * The flag is captured rather than read per call: the component caches the
   * rows it drew, so the value that built it is the only one it could honour.
   */
  private options(live: boolean): MarkdownOptions | undefined {
    const mermaid = this.mermaid
    if (mermaid === undefined) return undefined
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
