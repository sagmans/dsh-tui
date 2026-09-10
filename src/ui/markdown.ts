import { Markdown, type MarkdownTheme } from '@earendil-works/pi-tui'

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

  constructor(private readonly theme: MarkdownTheme) {}

  render(text: string, width: number): string[] {
    let message = this.parsed.get(text)
    if (message === undefined) {
      if (this.parsed.size >= MARKDOWN_CACHE_LIMIT) {
        const oldest = this.parsed.keys().next()
        if (oldest.done !== true) this.parsed.delete(oldest.value)
      }
      message = new Markdown(text, 0, 0, this.theme)
    } else {
      // Reinserting keeps a message that is still on screen from ageing out.
      this.parsed.delete(text)
    }
    this.parsed.set(text, message)
    return message.render(Math.max(1, Math.floor(width)))
  }
}
