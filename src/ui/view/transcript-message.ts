/**
 * How one non-tool message draws: user and assistant text, a folded thought, and
 * the notices and markers a session records between them.
 *
 * These rows share the recessive markdown theme and the framed-copy bookkeeping
 * the view reads back, so they belong together rather than beside the row cache
 * that only decides which of them to rebuild.
 */
import { type MarkdownTheme, visibleWidth } from '@earendil-works/pi-tui'
import { type Spacing } from '../../spacing.ts'
import { type TranscriptEntry } from '../../transcript.ts'
import { type TuiToken } from '../../theme-tokens.ts'
import { type TuiTheme } from '../../theme.ts'
import { codeBlockLines } from '../diff.ts'
import { canFrame, frameBlock, RAIL_COLUMNS, textWidth, type FrameRow } from '../frame.ts'
import { gapRows } from '../gap.ts'
import { ANSWER_FACE, type MarkdownFace, type MarkdownRenderer } from '../markdown.ts'
import { type ClickSpan } from '../view.ts'

const DETAIL_INDENT = '    '
/**
 * A markdown theme that keeps every element in one token.
 *
 * A thought is deliberately recessive, and the answer's theme would let a
 * heading or a link inside it outshine the answer it produced. The structure
 * still shows because markdown draws it around the text — bullets, fences,
 * indents, table rules — rather than in the text's own colour. A fenced diff is
 * the one block that does not recede: red and green are what the fence means
 * rather than how loudly it is drawn, and a thought showing a change is the
 * place the reader most needs to see which side of it moved.
 */
function recessiveMarkdownTheme(style: (text: string) => string, theme: TuiTheme): MarkdownTheme {
  return {
    heading: style,
    link: style,
    linkUrl: style,
    code: style,
    codeBlock: style,
    codeBlockBorder: style,
    quote: style,
    quoteBorder: style,
    hr: style,
    listBullet: style,
    bold: style,
    italic: style,
    strikethrough: style,
    underline: style,
    highlightCode: (code, lang) => codeBlockLines(code, lang, {
      style: (token, text) => theme.style(token, text),
      visible: token => theme.visible(token),
      plain: style,
    }),
  }
}

/** Keep fold policy in the view so drawing a message does not own interaction state. */
export interface MessagesContext {
  readonly theme: TuiTheme
  readonly markdown: MarkdownRenderer
  readonly reasoningOpen: (entry: Extract<TranscriptEntry, { kind: 'reasoning' }>) => boolean
  readonly reasoningFoldHint: () => string
  readonly reasoningKey: (id: string) => string | undefined
  /** Read current spacing so hot-reloaded settings do not leave frames using startup gaps. */
  readonly spacing: () => Spacing
  readonly pushWrapped: (lines: string[], text: string, width: number, prefix: string, token: TuiToken) => void
}

export class Messages {
  constructor(private readonly context: MessagesContext) {}

  /**
     * Normalize foreign terminal controls before markdown measures text: sequences
     * outside the supported SGR subset can corrupt width accounting or trigger
     * terminal actions.
     */
    private markdownLines(text: string, width: number, live: boolean, face: MarkdownFace, column = 0): string[] {
      return this.context.markdown
        .render(this.context.theme.rich(text, { column }), Math.max(1, width), live, face)
        .map(line => line.replace(/[ \t]+$/u, ''))
    }
  /**
     * Render one message's text as markdown.
     *
     * A thought passes its own face and an indent, so the row stays visibly a
     * detail of the step that produced it rather than a second answer.
     */
    private pushMarkdown(
      lines: string[],
      text: string,
      width: number,
      live: boolean,
      face: MarkdownFace = ANSWER_FACE,
      indent = '',
    ): void {
      const lead = visibleWidth(indent)
      for (const line of this.markdownLines(text, Math.max(1, width - lead), live, face, lead)) {
        // A blank markdown line stays blank: it shows nothing, so it holds nothing.
        if (line === '') {
          lines.push('')
          continue
        }
        lines.push(this.context.theme.cut(`${indent}${line}`, width, '…'))
      }
    }
  /**
     * One message closed into a frame, with its markdown laid out to what is left inside.
     *
     * A prompt and a reply are the two objects of an exchange, so both are drawn as
     * bars rather than as one more stretch of rows; the face, the border's element,
     * and whether the text is still arriving are the only differences. Markdown lays
     * itself out to the frame's text width, so the frame may only place the rows:
     * wrapping them again would break what it drew. The rows are recorded as they
     * are drawn, because a copy of this message will carry the frame with it and
     * only the drawing knows which columns of a row are the frame's.
     */
    pushFramed(lines: string[], copy: FrameRow[], text: string, width: number, live: boolean, face: MarkdownFace, borderToken: TuiToken): void {
      const framed = canFrame(width, this.context.theme.visible(borderToken), true)
      const inside = framed ? width - RAIL_COLUMNS : width
      const body = this.markdownLines(text, textWidth(inside), live, face)
      const block = frameBlock(body, width, {
        text: line => line,
        border: rule => this.context.theme.style(borderToken, rule),
        framed,
        rail: true,
      })
      // A card is an object of the transcript rather than a paragraph of it, so it
      // opens and closes with air: the prompt and the reply of one exchange stop
      // touching, and so do the rows of a turn after them. The rows are the
      // frame's own and carry no text, so a copy of the message leaves them out.
      const air = gapRows(this.context.spacing().messages)
      // Retained messages can exceed the engine's function-argument limit on narrow terminals.
      for (const rows of [air, block.drawn, air]) {
        for (const row of rows) lines.push(row)
      }
      for (const row of block.copy) copy.push(row)
    }
  /**
     * The face a thought is drawn in.
     *
     * Its shade stays the thought body's and it asks for no drawing: a diagram in
     * the middle of a thought would carry the answer's weight, and the answer's
     * colours would make the thinking compete with it.
     */
    private reasoningFace(): MarkdownFace {
      const body = (text: string): string => this.context.theme.style('transcript.reasoning.body', text)
      return { name: 'reasoning', base: { color: body }, theme: recessiveMarkdownTheme(body, this.context.theme), transform: false }
    }
  /** Keep submitted prompts in their transcript shade rather than inheriting the live editor’s styling. */
    userFace(): MarkdownFace {
      return { name: 'user', base: { color: text => this.context.theme.style('transcript.user', text) } }
    }
  pushReasoning(lines: string[], entry: Extract<TranscriptEntry, { kind: 'reasoning' }>, width: number, spans: ClickSpan[]): void {
      // The summary anchors the foldable thought; hiding it removes the detail
      // and its hit target too, so no body remains detached from its summary.
      if (!this.context.theme.visible('transcript.reasoning.summary')) return
      const start = lines.length
      const open = this.context.reasoningOpen(entry)
      const glyph = this.context.theme.glyph('transcript.reasoning.summary')
      const lead = glyph === '' ? '' : `${glyph} `
      // A folded row carries the key that opens it, because a count with no way to
      // reach the text reads the same as the text never having arrived. The key
      // rides the row rather than a line of its own, so naming the hidden body
      // costs no vertical space.
      const suffix = !open && entry.body !== '' && this.context.theme.visible('transcript.reasoning.hint')
        ? ` (${this.context.reasoningFoldHint()})`
        : ''
      // The key is kept whole: the summary is the part that gives up room.
      const room = Math.max(1, width - visibleWidth(suffix))
      const summary = this.context.theme.cut(this.context.theme.rich(`${lead}${entry.summary}`, { token: 'transcript.reasoning.summary', column: visibleWidth(lead) }), room, '')
      const lined = suffix === '' ? summary : `${summary}${this.context.theme.style('transcript.reasoning.hint', suffix)}`
      // The key is kept whole only while the row has room for it: a row wider than
      // the surface loses its tail to the terminal, and the terminal's clamp is not
      // one this component can count on.
      lines.push(this.context.theme.cut(lined, width, '…'))
      if (open && this.context.theme.visible('transcript.reasoning.body')) {
        this.pushMarkdown(lines, entry.body, width, entry.live, this.reasoningFace(), DETAIL_INDENT)
      }
      // Include the body so an opened thought can be folded where the reader is
      // reading it. Without a stable key, a click cannot remember this thought
      // independently, so it remains governed by the view-wide fold policy.
      const key = this.context.reasoningKey(entry.id)
      if (key !== undefined) spans.push({ key, start, end: lines.length, expanded: open })
    }
  /** Keep notice and marker prefixes under their own element policy so hiding one cannot leave an orphan glyph. */
    elementLead(token: TuiToken): string {
      const glyph = this.context.theme.visible(token) ? this.context.theme.glyph(token) : ''
      return glyph === '' ? '' : `${glyph} `
    }
}
