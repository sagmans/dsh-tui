import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import { cardDetailRows, type ToolCard } from '../cards.ts'
import type { GateCard } from '../gates.ts'
import { displayText } from '../text.ts'
import type { TranscriptEntry, TranscriptModel } from '../transcript.ts'
import type { TuiTheme } from '../theme.ts'
import type { MarkdownRenderer } from './markdown.ts'
import type { PickerCard } from './picker.ts'

const DETAIL_INDENT = '    '
const OPTION_INDENT = '   '

/** Which rows the reader has opened; one key decides for every row of a kind. */
export interface ViewState {
  readonly expandCards: boolean
  readonly expandReasoning: boolean
}

const ALL_COLLAPSED: ViewState = { expandCards: false, expandReasoning: false }

/**
 * Renders the transcript rows and any pending gate as terminal lines.
 *
 * The component stays a pure projection: it holds no cache of its own, so a
 * resize, a resume, or an open gate redraws the same rows without replaying
 * anything. Everything it draws came from a model, a tool, or a file, so the
 * text passes through the display escaping before it is styled.
 */
/** What sits below the transcript while the reader is being asked something. */
export interface TranscriptViewOptions {
  readonly state?: () => ViewState
  readonly gate?: () => GateCard | undefined
  readonly picker?: () => PickerCard | undefined
}

export class TranscriptView implements Component {
  constructor(
    private readonly model: TranscriptModel,
    private readonly theme: TuiTheme,
    private readonly markdown: MarkdownRenderer,
    private readonly options: TranscriptViewOptions = {},
  ) {}

  private get viewState(): ViewState {
    return this.options.state?.() ?? ALL_COLLAPSED
  }

  invalidate(): void {
    // The model, the gate, and the expansion state are the only inputs.
  }

  /** Wrap one text block under a prefix, keeping the prefix's column budget. */
  private pushWrapped(
    lines: string[],
    text: string,
    width: number,
    prefix: string,
    style: (text: string) => string,
  ): void {
    const lead = visibleWidth(prefix)
    const indent = ' '.repeat(lead)
    const wrapped = wrapTextWithAnsi(displayText(text), Math.max(1, width - lead))
    wrapped.forEach((line, index) => {
      lines.push(style(truncateToWidth(`${index === 0 ? prefix : indent}${line}`, width, '')))
    })
  }

  /** Render assistant text as markdown: the model writes structure, the reader reads it. */
  private pushMarkdown(lines: string[], text: string, width: number, prefix: string): void {
    const lead = visibleWidth(prefix)
    const indent = ' '.repeat(lead)
    const rendered = this.markdown.render(displayText(text), Math.max(1, width - lead))
    rendered.forEach((line, index) => {
      // The renderer pads to its width for background styling we do not use.
      const trimmed = line.replace(/[ \t]+$/u, '')
      lines.push(truncateToWidth(`${index === 0 ? prefix : indent}${trimmed}`, width, ''))
    })
  }

  private pushReasoning(lines: string[], entry: Extract<TranscriptEntry, { kind: 'reasoning' }>, width: number): void {
    lines.push(this.theme.dim(truncateToWidth(`${this.theme.glyphs.reasoning} ${displayText(entry.summary)}`, width, '')))
    if (!this.viewState.expandReasoning) return
    for (const line of entry.body.split('\n')) {
      this.pushWrapped(lines, line, width, DETAIL_INDENT, this.theme.dim)
    }
  }

  private pushCard(lines: string[], card: ToolCard, width: number): void {
    const expanded = this.viewState.expandCards
    const { lines: detail, hidden } = cardDetailRows(card, expanded)
    const mark = card.failed ? '✗' : '⚒'
    lines.push(this.theme.tool(truncateToWidth(`${mark} ${displayText(card.title)}`, width, '')))
    for (const row of detail) {
      const style = row.startsWith('+')
        ? this.theme.added
        : row.startsWith('-') ? this.theme.removed : this.theme.dim
      lines.push(style(truncateToWidth(`${DETAIL_INDENT}${displayText(row)}`, width, '')))
    }
    if (hidden > 0) {
      const hint = expanded ? `${hidden} more lines not shown` : `… ${hidden} more lines · ctrl+o shows them`
      lines.push(this.theme.dim(truncateToWidth(`${DETAIL_INDENT}${hint}`, width, '')))
    }
  }

  private pushPicker(lines: string[], picker: PickerCard, width: number): void {
    lines.push('')
    lines.push(this.theme.bold(truncateToWidth(`↻ ${displayText(picker.title)}`, width, '')))
    if (picker.filter !== '') {
      lines.push(this.theme.dim(truncateToWidth(`${DETAIL_INDENT}filter: ${displayText(picker.filter)}`, width, '')))
    }
    for (const row of picker.rows) {
      const cursor = row.current ? '❯' : ' '
      const text = row.description === undefined
        ? `${cursor} ${row.label}`
        : `${cursor} ${row.label} — ${row.description}`
      const style = row.current ? this.theme.bold : (value: string) => value
      lines.push(style(truncateToWidth(`${OPTION_INDENT}${displayText(text)}`, width, '')))
    }
    lines.push(this.theme.dim(truncateToWidth(`${OPTION_INDENT}${displayText(picker.hint)}`, width, '')))
  }

  private pushGate(lines: string[], gate: GateCard, width: number): void {
    lines.push('')
    lines.push(this.theme.bold(truncateToWidth(`${gate.kind === 'approval' ? '⚠' : '?'} ${displayText(gate.title)}`, width, '')))
    for (const detail of gate.detail) {
      this.pushWrapped(lines, detail, width, DETAIL_INDENT, this.theme.dim)
    }
    gate.options.forEach((option, position) => {
      const box = option.selected ? '[x]' : '[ ]'
      const cursor = option.current ? '❯' : ' '
      const label = displayText(option.label)
      const text = option.description === undefined
        ? `${cursor} ${box} ${position + 1}. ${label}`
        : `${cursor} ${box} ${position + 1}. ${label} — ${displayText(option.description)}`
      const style = option.current ? this.theme.bold : (value: string) => value
      lines.push(style(truncateToWidth(`${OPTION_INDENT}${text}`, width, '')))
    })
    lines.push(this.theme.dim(truncateToWidth(`${OPTION_INDENT}${displayText(gate.hint)}`, width, '')))
  }

  render(width: number): string[] {
    if (width <= 0) return []
    const { glyphs } = this.theme
    const lines: string[] = []
    for (const entry of this.model.entries()) {
      switch (entry.kind) {
        case 'tool':
          this.pushCard(lines, entry.card, width)
          break
        case 'reasoning':
          this.pushReasoning(lines, entry, width)
          break
        case 'assistant':
          this.pushMarkdown(lines, entry.text, width, `${glyphs.assistant} `)
          break
        case 'user':
          this.pushWrapped(lines, entry.text, width, `${glyphs.user} `, this.theme.bold)
          break
        case 'notice':
          this.pushWrapped(lines, entry.text, width, `${glyphs.notice} `, this.theme.notice)
          break
        case 'marker':
          this.pushWrapped(lines, entry.text, width, `${glyphs.marker} `, this.theme.marker)
          break
      }
    }
    const picker = this.options.picker?.()
    if (picker !== undefined) this.pushPicker(lines, picker, width)
    const gate = this.options.gate?.()
    if (gate !== undefined) this.pushGate(lines, gate, width)
    return lines
  }
}
