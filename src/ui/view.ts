import { type Component, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import type { TranscriptModel } from '../transcript.ts'
import type { TuiTheme } from '../theme.ts'

/**
 * Renders the transcript rows as terminal lines.
 *
 * The component stays a pure projection of the model: it owns no state beyond
 * the last width it wrapped for, so a resize or a resume re-renders the same
 * rows without replaying anything.
 */
export class TranscriptView implements Component {
  constructor(
    private readonly model: TranscriptModel,
    private readonly theme: TuiTheme,
  ) {}

  invalidate(): void {
    // The model is the only state; nothing is cached across renders.
  }

  render(width: number): string[] {
    if (width <= 0) return []
    const { glyphs } = this.theme
    const lines: string[] = []
    for (const entry of this.model.entries()) {
      const glyph = glyphs[entry.kind]
      const style = entry.kind === 'tool'
        ? this.theme.tool
        : entry.kind === 'notice'
          ? this.theme.notice
          : (text: string) => text
      const body = entry.kind === 'user' ? this.theme.bold(entry.text) : entry.text
      const continuation = ' '.repeat(2)
      const wrapped = wrapTextWithAnsi(body, Math.max(1, width - 2))
      wrapped.forEach((line, index) => {
        const prefix = index === 0 ? `${glyph} ` : continuation
        lines.push(style(truncateToWidth(`${prefix}${line}`, width, '')))
      })
    }
    return lines
  }
}
