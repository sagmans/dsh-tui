import { type Component, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import { cardDetailRows, type ToolCard } from '../cards.ts'
import type { GateCard } from '../gates.ts'
import { displayText } from '../text.ts'
import type { TranscriptEntry, TranscriptModel } from '../transcript.ts'
import { CARD_ROW_TOKEN, type TuiToken } from '../theme-tokens.ts'
import type { TuiTheme } from '../theme.ts'
import type { MarkdownRenderer } from './markdown.ts'
import type { PickerCard } from './picker.ts'
import { RowCache } from './rows.ts'

const DETAIL_INDENT = '    '
const OPTION_INDENT = '   '

/** The mark a cursor falls back to when the reader has not set one, so no literal lives in a template. */
const CURSOR_MARK = '❯'
const APPROVAL_MARK = '⚠'
const QUESTION_MARK = '?'
const CHECKBOX_ON = '[x]'
const CHECKBOX_OFF = '[ ]'

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
  /** Injectable so a test can see that a repaint reused the rows it had. */
  readonly rows?: RowCache<TranscriptEntry>
}

export class TranscriptView implements Component {
  private readonly rows: RowCache<TranscriptEntry>

  constructor(
    private readonly model: TranscriptModel,
    private readonly theme: TuiTheme,
    private readonly markdown: MarkdownRenderer,
    private readonly options: TranscriptViewOptions = {},
  ) {
    this.rows = options.rows ?? new RowCache<TranscriptEntry>()
  }

  private get viewState(): ViewState {
    return this.options.state?.() ?? ALL_COLLAPSED
  }

  /** The cache's own account of the work it avoided; a test reads this. */
  rowStats(): { readonly hits: number; readonly misses: number; readonly size: number } {
    return this.rows.stats()
  }

  invalidate(): void {
    // The rows are keyed by width and expansion state, so a real change misses
    // anyway; an explicit invalidate means the caller wants them rebuilt.
    this.rows.clear()
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
      lines.push(style(this.theme.cut(`${index === 0 ? prefix : indent}${line}`, width, '')))
    })
  }

  /** Render assistant text as markdown: the model writes structure, the reader reads it. */
  private pushMarkdown(lines: string[], text: string, width: number): void {
    const rendered = this.markdown.render(displayText(text), Math.max(1, width))
    rendered.forEach(line => {
      // The renderer pads to its width for background styling we do not use.
      const trimmed = line.replace(/[ \t]+$/u, '')
      // A blank markdown line stays blank: it shows nothing, so it holds nothing.
      if (trimmed === '') {
        lines.push('')
        return
      }
      lines.push(this.theme.cut(trimmed, width, '…'))
    })
  }

  private pushReasoning(lines: string[], entry: Extract<TranscriptEntry, { kind: 'reasoning' }>, width: number): void {
    if (!this.theme.visible('transcript.reasoning.summary')) return
    const glyph = this.theme.glyph('transcript.reasoning.summary')
    const lead = glyph === '' ? '' : `${glyph} `
    lines.push(this.theme.style('transcript.reasoning.summary', this.theme.cut(`${lead}${displayText(entry.summary)}`, width, '')))
    if (!this.viewState.expandReasoning) {
      // The row says thinking happened; without this the reader has no way to
      // learn the body is there, which reads as the text having been dropped.
      if (this.theme.visible('transcript.reasoning.hint') && entry.body !== '') {
        const hint = `${DETAIL_INDENT}ctrl+t shows it`
        lines.push(this.theme.style('transcript.reasoning.hint', this.theme.cut(hint, width, '')))
      }
      return
    }
    if (!this.theme.visible('transcript.reasoning.body')) return
    for (const line of entry.body.split('\n')) {
      this.pushWrapped(lines, line, width, DETAIL_INDENT, text => this.theme.style('transcript.reasoning.body', text))
    }
  }

  private pushCard(lines: string[], card: ToolCard, width: number): void {
    const expanded = this.viewState.expandCards
    const { lines: detail, hidden } = cardDetailRows(card, expanded)
    const titleToken = card.failed ? 'tool.failed.title' : 'tool.title'
    const glyphToken = card.failed ? 'tool.failed.glyph' : 'tool.glyph'
    if (this.theme.visible(titleToken)) {
      const glyph = this.theme.glyph(glyphToken)
      const lead = glyph === '' ? '' : `${glyph} `
      lines.push(this.theme.style(titleToken, this.theme.cut(`${lead}${displayText(card.title)}`, width, '')))
    }
    for (const row of detail) {
      // The row says what it is, so the renderer never guesses from the text:
      // a diff line beginning with "+" is an addition because the presenter
      // said so, not because of its first character.
      const drawn = row.parts
        .map(part => {
          const token = CARD_ROW_TOKEN[card.kind]?.[part.class] ?? 'tool.detail'
          return this.theme.visible(token) ? this.theme.style(token, displayText(part.text)) : ''
        })
        .join('')
      // A row whose every part is hidden draws nothing, and nothing must not
      // cost a line: the indent would read as an empty row the card does not have.
      if (drawn === '') continue
      lines.push(this.theme.cut(`${DETAIL_INDENT}${drawn}`, width, ''))
    }
    if (hidden > 0 && this.theme.visible('tool.hint')) {
      const hint = expanded ? `${hidden} more lines not shown` : `… ${hidden} more lines · ctrl+o shows them`
      lines.push(this.theme.style('tool.hint', this.theme.cut(`${DETAIL_INDENT}${hint}`, width, '')))
    }
  }

  private pushPicker(lines: string[], picker: PickerCard, width: number): void {
    lines.push('')
    if (this.theme.visible('picker.title')) {
      const glyph = this.theme.glyph('picker.glyph')
      const lead = glyph === '' ? '' : `${glyph} `
      lines.push(this.theme.style('picker.title', this.theme.cut(`${lead}${displayText(picker.title)}`, width, '')))
    }
    if (picker.note !== undefined && this.theme.visible('picker.note')) {
      this.pushWrapped(lines, picker.note, width, DETAIL_INDENT, text => this.theme.style('picker.note', text))
    }
    if (picker.filter !== '' && this.theme.visible('picker.filter')) {
      lines.push(this.theme.style('picker.filter', this.theme.cut(`${DETAIL_INDENT}filter: ${displayText(picker.filter)}`, width, '')))
    }
    if (picker.above > 0 && this.theme.visible('picker.scrollNewer')) {
      lines.push(this.theme.style('picker.scrollNewer', this.theme.cut(`${OPTION_INDENT}… ${picker.above} newer`, width, '')))
    }
    for (const row of picker.rows) {
      const token = row.current ? 'picker.rowCurrent' : 'picker.row'
      if (!this.theme.visible(token)) continue
      const cursor = row.current ? this.theme.glyph('picker.cursor') || CURSOR_MARK : ' '
      const text = row.description === undefined
        ? `${cursor} ${row.label}`
        : `${cursor} ${row.label} — ${row.description}`
      lines.push(this.theme.style(token, this.theme.cut(`${OPTION_INDENT}${displayText(text)}`, width, '')))
    }
    if (picker.below > 0 && this.theme.visible('picker.scrollOlder')) {
      lines.push(this.theme.style('picker.scrollOlder', this.theme.cut(`${OPTION_INDENT}… ${picker.below} older`, width, '')))
    }
    if (this.theme.visible('picker.hint')) {
      lines.push(this.theme.style('picker.hint', this.theme.cut(`${OPTION_INDENT}${displayText(picker.hint)}`, width, '')))
    }
  }

  private pushGate(lines: string[], gate: GateCard, width: number): void {
    lines.push('')
    if (this.theme.visible('gate.title')) {
      const glyphToken = gate.kind === 'approval' ? 'gate.glyphApproval' : 'gate.glyphQuestion'
      const glyph = this.theme.glyph(glyphToken) || (gate.kind === 'approval' ? APPROVAL_MARK : QUESTION_MARK)
      lines.push(this.theme.style('gate.title', this.theme.cut(`${glyph} ${displayText(gate.title)}`, width, '')))
    }
    if (this.theme.visible('gate.detail')) {
      for (const detail of gate.detail) {
        this.pushWrapped(lines, detail, width, DETAIL_INDENT, text => this.theme.style('gate.detail', text))
      }
    }
    gate.options.forEach((option, position) => {
      const token = option.current ? 'gate.optionCurrent' : 'gate.option'
      if (!this.theme.visible(token)) return
      const box = option.selected ? CHECKBOX_ON : CHECKBOX_OFF
      const cursor = option.current ? this.theme.glyph('gate.cursor') || CURSOR_MARK : ' '
      const label = displayText(option.label)
      const text = option.description === undefined
        ? `${cursor} ${box} ${position + 1}. ${label}`
        : `${cursor} ${box} ${position + 1}. ${label} — ${displayText(option.description)}`
      lines.push(this.theme.style(token, this.theme.cut(`${OPTION_INDENT}${text}`, width, '')))
    })
    if (this.theme.visible('gate.hint')) {
      lines.push(this.theme.style('gate.hint', this.theme.cut(`${OPTION_INDENT}${displayText(gate.hint)}`, width, '')))
    }
  }

  /** The rows one transcript entry becomes. */
  private renderEntry(entry: TranscriptEntry, lines: string[], width: number): void {
    switch (entry.kind) {
      case 'tool':
        this.pushCard(lines, entry.card, width)
        return
      case 'reasoning':
        this.pushReasoning(lines, entry, width)
        return
      case 'assistant':
        this.pushMarkdown(lines, entry.text, width)
        return
      case 'user':
        if (!this.theme.visible('transcript.user')) return
        this.pushWrapped(lines, entry.text, width, this.elementLead('transcript.user'), text => this.theme.style('transcript.user', text))
        return
      case 'notice':
        if (!this.theme.visible('transcript.notice')) return
        this.pushWrapped(lines, entry.text, width, this.elementLead('transcript.notice'), text => this.theme.style('transcript.notice', text))
        return
      case 'marker':
        if (!this.theme.visible('transcript.marker')) return
        this.pushWrapped(lines, entry.text, width, this.elementLead('transcript.marker'), text => this.theme.style('transcript.marker', text))
        return
    }
  }

  /** The mark and the space that introduce an element, empty when it has none. */
  private elementLead(token: TuiToken): string {
    const glyph = this.theme.visible(token) ? this.theme.glyph(token) : ''
    return glyph === '' ? '' : `${glyph} `
  }

  render(width: number): string[] {
    if (width <= 0) return []
    const state = this.viewState
    // The revision is part of the key: rows drawn under an older theme table
    // must miss, or a settings change would restyle only the rows that happened
    // to be redrawn for another reason.
    const tag = `${width}|${state.expandCards ? 'c' : '-'}${state.expandReasoning ? 'r' : '-'}|${this.theme.revision}`
    const lines: string[] = []
    const settled = this.model.settledCount()
    const entries = this.model.entries()
    for (const [index, entry] of entries.entries()) {
      // The in-flight rows change on every frame, so caching them would only
      // fill the cache with objects nobody will ask for again.
      if (index >= settled) {
        this.renderEntry(entry, lines, width)
        continue
      }
      const cached = this.rows.lookup(entry, tag)
      if (cached !== undefined) {
        lines.push(...cached)
        continue
      }
      const rendered: string[] = []
      this.renderEntry(entry, rendered, width)
      this.rows.store(entry, tag, rendered)
      lines.push(...rendered)
    }
    const picker = this.options.picker?.()
    if (picker !== undefined) this.pushPicker(lines, picker, width)
    const gate = this.options.gate?.()
    if (gate !== undefined) this.pushGate(lines, gate, width)
    return lines
  }
}
