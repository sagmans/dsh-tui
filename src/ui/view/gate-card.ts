/**
 * How a pending gate draws: its marks, its numbered options, and the free-text
 * row beneath them.
 *
 * The view decides where a gate sits in the frame; below that is the gate's own
 * vocabulary, which changes with the question rather than with the transcript.
 */
import { visibleWidth } from '@earendil-works/pi-tui'
import { CUSTOM_ROW_NUMBER, type GateCard } from '../../gates.ts'
import { type TuiToken } from '../../theme-tokens.ts'
import { type TuiTheme } from '../../theme.ts'

const OPTION_INDENT = '   '
/** The mark a cursor falls back to when the reader has not set one, so no literal lives in a template. */
const CURSOR_MARK = '❯'
const APPROVAL_MARK = '⚠'
const QUESTION_MARK = '?'
const CHECKBOX_ON = '[x]'
const CHECKBOX_OFF = '[ ]'
/** An unselected row has no cursor, and a blank column is not a value to configure. */
const NO_CURSOR = ' '
/** One row a gate draws: a numbered option, or the free-text row below them. */
interface GateRow {
  readonly number: number
  readonly label: string
  readonly description: string | undefined
  readonly current: boolean
  readonly selected: boolean
}
/** The indent a gate's own detail rows sit under, one step inside the title they explain. */
const DETAIL_INDENT = '    '

export interface GateCardsContext {
  readonly theme: TuiTheme
  readonly pushWrapped: (lines: string[], text: string, width: number, prefix: string, token: TuiToken) => void
}

export class GateCards {
  constructor(private readonly context: GateCardsContext) {}

  pushGate(lines: string[], gate: GateCard, width: number): void {
      lines.push('')
      if (this.context.theme.visible('gate.title')) {
        const glyphToken = gate.kind === 'approval' ? 'gate.glyphApproval' : 'gate.glyphQuestion'
        const glyph = this.context.theme.glyph(glyphToken) || (gate.kind === 'approval' ? APPROVAL_MARK : QUESTION_MARK)
        // The question is the thing being decided, so it wraps rather than being
        // cut: a reader cannot answer a sentence they were not shown.
        this.context.pushWrapped(lines, gate.title, width, `${glyph} `, 'gate.title')
      }
      if (this.context.theme.visible('gate.detail')) {
        for (const detail of gate.detail) {
          this.context.pushWrapped(lines, detail, width, DETAIL_INDENT, 'gate.detail')
        }
      }
      gate.options.forEach((option, position) => {
        this.pushGateRow(lines, width, {
          number: gate.optionOffset + position + 1,
          label: option.label,
          description: option.description,
          current: option.current,
          selected: option.selected,
        })
      })
      // The free-text row is drawn under the window rather than inside it: it is
      // the one row that must never scroll out of reach, and the window's own
      // numbering is left running 1..n above it.
      if (gate.custom !== undefined) {
        this.pushGateRow(lines, width, {
          number: CUSTOM_ROW_NUMBER,
          label: gate.custom.label,
          description: gate.custom.description,
          current: gate.custom.current,
          selected: gate.custom.selected,
        })
      }
      // The answer belongs to the row it fills: the free-text row, or the question
      // itself when typing is the only way to answer it. The rows come from the
      // surface's own editor, so they are placed rather than restyled — it draws
      // its frame, its padding, and its cursor for the width it is given.
      if (gate.answerInput !== undefined) {
        const room = Math.max(1, width - visibleWidth(OPTION_INDENT))
        // A surface narrower than the indent cannot place the answer: that row is cut
        // here so what is handed out already fits, rather than being trimmed at the
        // terminal past the point where the view could count it. A row that fits is
        // left exactly as the editor drew it, cursor styling included.
        for (const row of gate.answerInput.render(room)) {
          const placed = `${OPTION_INDENT}${row}`
          lines.push(visibleWidth(placed) <= width ? placed : this.context.theme.cut(placed, width, ''))
        }
      }
      // The keys are how the gate is answered at all, so they wrap rather than
      // lose their tail at a narrow edge.
      if (this.context.theme.visible('gate.hint')) {
        this.context.pushWrapped(lines, gate.hint, width, OPTION_INDENT, 'gate.hint')
      }
    }
  /**
     * One row a reader can choose: the cursor, the box, the number, the label.
     *
     * The row wraps under the label it belongs to rather than at the screen edge,
     * because the label and its description together are what tells two rows
     * apart, and a mark on a continuation line reads as another row.
     */
    private pushGateRow(lines: string[], width: number, row: GateRow): void {
      const token = row.current ? 'gate.optionCurrent' : 'gate.option'
      if (!this.context.theme.visible(token)) return
      const cursor = row.current ? this.context.theme.glyph('gate.cursor') || CURSOR_MARK : NO_CURSOR
      const box = row.selected ? CHECKBOX_ON : CHECKBOX_OFF
      const lead = `${OPTION_INDENT}${cursor} ${box} ${row.number}. `
      const text = row.description === undefined ? row.label : `${row.label} — ${row.description}`
      // The text reaches pushWrapped undrawn: it is read once there, and reading
      // it twice would show the reader the escape instead of the character.
      this.context.pushWrapped(lines, text, width, lead, token)
    }
}
