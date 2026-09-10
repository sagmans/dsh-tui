import { type Component, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import type { ToolCard } from '../cards.ts'
import type { TranscriptEntry, TranscriptModel } from '../transcript.ts'
import type { TuiTheme } from '../theme.ts'

const CONTINUATION = '  '
const DETAIL_INDENT = '    '

/**
 * Renders the transcript rows as terminal lines.
 *
 * The component stays a pure projection of the model: it owns no cache beyond
 * the render call, so a resize or a resume re-renders the same rows without
 * replaying anything.
 */
export class TranscriptView implements Component {
  constructor(
    private readonly model: TranscriptModel,
    private readonly theme: TuiTheme,
  ) {}

  invalidate(): void {
    // The model is the only state; nothing is cached across renders.
  }

  private pushWrapped(lines: string[], text: string, width: number, prefix: string, style: (text: string) => string): void {
    const wrapped = wrapTextWithAnsi(text, Math.max(1, width - prefix.length))
    wrapped.forEach((line, index) => {
      const lead = index === 0 ? prefix : CONTINUATION
      lines.push(style(truncateToWidth(`${lead}${line}`, width, '')))
    })
  }

  private pushCard(lines: string[], card: ToolCard, width: number): void {
    const mark = card.failed ? '✗' : '⚒'
    const header = this.theme.tool(truncateToWidth(`${mark} ${card.title}`, width, ''))
    lines.push(header)
    for (const detail of card.detail) {
      const style = detail.startsWith('+')
        ? this.theme.added
        : detail.startsWith('-') ? this.theme.removed : this.theme.dim
      lines.push(style(truncateToWidth(`${DETAIL_INDENT}${detail}`, width, '')))
    }
    if (card.hiddenLines > 0) {
      lines.push(this.theme.dim(truncateToWidth(`${DETAIL_INDENT}… ${card.hiddenLines} more lines`, width, '')))
    }
  }

  render(width: number): string[] {
    if (width <= 0) return []
    const { glyphs } = this.theme
    const lines: string[] = []
    for (const entry of this.model.entries()) {
      if (entry.kind === 'tool') {
        this.pushCard(lines, entry.card, width)
        continue
      }
      if (entry.kind === 'reasoning') {
        const text = entry.live ? `${glyphs.reasoning} ${entry.text}` : `${glyphs.reasoning} ${entry.text}`
        lines.push(this.theme.dim(truncateToWidth(text, width, '')))
        continue
      }
      const prefix = `${glyphs[entry.kind]} `
      const style = entry.kind === 'notice' ? this.theme.notice : (value: string) => value
      this.pushWrapped(lines, entry.kind === 'user' ? this.theme.bold(entry.text) : entry.text, width, prefix, style)
    }
    return lines
  }
}

/** Narrowing helper kept for callers that switch on entry kinds. */
export type { TranscriptEntry }
