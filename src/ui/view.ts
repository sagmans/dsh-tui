import { type Component, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import type { ToolCard } from '../cards.ts'
import type { GateCard } from '../gates.ts'
import type { TranscriptModel } from '../transcript.ts'
import type { TuiTheme } from '../theme.ts'

const CONTINUATION = '  '
const DETAIL_INDENT = '    '
const OPTION_INDENT = '   '

/**
 * Renders the transcript rows and any pending gate as terminal lines.
 *
 * The component stays a pure projection: it owns no cache beyond the render
 * call, so a resize, a resume, or an open gate re-renders the same rows without
 * replaying anything.
 */
export class TranscriptView implements Component {
  constructor(
    private readonly model: TranscriptModel,
    private readonly theme: TuiTheme,
    private readonly pendingGate: () => GateCard | undefined = () => undefined,
  ) {}

  invalidate(): void {
    // The model and the gate are the only state; nothing is cached.
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
    lines.push(this.theme.tool(truncateToWidth(`${mark} ${card.title}`, width, '')))
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

  private pushGate(lines: string[], gate: GateCard, width: number): void {
    lines.push('')
    lines.push(this.theme.bold(truncateToWidth(`${gate.kind === 'approval' ? '⚠' : '?'} ${gate.title}`, width, '')))
    for (const detail of gate.detail) {
      this.pushWrapped(lines, detail, width, DETAIL_INDENT, this.theme.dim)
    }
    gate.options.forEach((option, position) => {
      const box = option.selected ? '[x]' : '[ ]'
      const cursor = option.current ? '❯' : ' '
      const text = option.description === undefined
        ? `${cursor} ${box} ${position + 1}. ${option.label}`
        : `${cursor} ${box} ${position + 1}. ${option.label} — ${option.description}`
      const style = option.current ? this.theme.bold : (value: string) => value
      lines.push(style(truncateToWidth(`${OPTION_INDENT}${text}`, width, '')))
    })
    lines.push(this.theme.dim(truncateToWidth(`${OPTION_INDENT}${gate.hint}`, width, '')))
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
        lines.push(this.theme.dim(truncateToWidth(`${glyphs.reasoning} ${entry.text}`, width, '')))
        continue
      }
      const prefix = `${glyphs[entry.kind]} `
      const style = entry.kind === 'notice' ? this.theme.notice : (value: string) => value
      this.pushWrapped(lines, entry.kind === 'user' ? this.theme.bold(entry.text) : entry.text, width, prefix, style)
    }
    const gate = this.pendingGate()
    if (gate !== undefined) this.pushGate(lines, gate, width)
    return lines
  }
}
