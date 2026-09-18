import { type Component, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import { displayText } from '../text.ts'
import type { TuiTheme } from '../theme.ts'
import { FRAME_COLUMNS, FRAME_GLYPHS, MIN_BOX_WIDTH, frameRule, textRow, textWidth } from './frame.ts'

/** Queued prompts the bar draws; everything older becomes one count above them. */
export const QUEUE_LIMIT = 3
/** Text rows one queued prompt keeps before its own count takes over. */
export const QUEUE_TEXT_ROWS = 3

/**
 * The prompts the agent has not taken yet, drawn above the editor.
 *
 * The rows take the editor's own frame because that is what they are: input the
 * reader already submitted, waiting for the agent to reach it. Only the face
 * differs — faint and italic — so a reader can tell at a glance that the text is
 * waiting rather than being typed.
 */
export class QueueBar implements Component {
  constructor(
    private readonly prompts: () => readonly string[],
    private readonly theme: TuiTheme,
  ) {}

  invalidate(): void {
    // Nothing is cached: the prompts are read fresh on every frame.
  }

  /** One queued prompt as the editor bar's own box, drawn in the queued face. */
  private box(text: string, width: number, framed: boolean): string[] {
    const inside = framed ? width - FRAME_COLUMNS : width
    const wrapped = wrapTextWithAnsi(displayText(text), textWidth(inside))
    // A prompt can be longer than the screen; the reader needs to see that it is
    // waiting, not to re-read all of it, so the first rows stand for the whole.
    const body = wrapped.slice(0, QUEUE_TEXT_ROWS)
    const rows = body.map(line => textRow(this.theme.style('editor.queued', line), inside))
    if (!framed) return rows
    const side = this.theme.editor.borderColor(FRAME_GLYPHS.side)
    return [
      this.theme.editor.borderColor(`${FRAME_GLYPHS.topLeft}${frameRule(inside, 0)}${FRAME_GLYPHS.topRight}`),
      ...rows.map(row => `${side}${row}${side}`),
      this.theme.editor.borderColor(`${FRAME_GLYPHS.bottomLeft}${frameRule(inside, wrapped.length - body.length)}${FRAME_GLYPHS.bottomRight}`),
    ]
  }

  render(width: number): string[] {
    if (width <= 0) return []
    const prompts = this.prompts()
    if (prompts.length === 0) return []
    // Hiding the face hides the rows: a frame around text the reader cannot read
    // would look like an empty prompt waiting to be typed into.
    if (!this.theme.visible('editor.queued')) return []
    const framed = width >= MIN_BOX_WIDTH && this.theme.visible('editor.border')
    const shown = prompts.slice(-QUEUE_LIMIT)
    const lines: string[] = []
    // The reader typed the newest prompt last, so that is the row that must stay
    // on screen; the ones dropped here are the ones a claim is about to take.
    if (shown.length < prompts.length) {
      lines.push(this.theme.style('editor.queued.more', this.theme.cut(`… ${prompts.length - shown.length} queued earlier`, width, '…')))
    }
    for (const prompt of shown) lines.push(...this.box(prompt, width, framed))
    return lines
  }
}
