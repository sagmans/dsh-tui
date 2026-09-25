/**
 * How one non-tool message draws: user and assistant text, a folded thought, and
 * the notices and markers a session records between them.
 *
 * These rows share the recessive markdown theme and the framed-copy bookkeeping
 * the view reads back, so they belong together rather than beside the row cache
 * that only decides which of them to rebuild.
 */
import { type MarkdownTheme, visibleWidth } from '@earendil-works/pi-tui'
import { type TranscriptEntry } from '../../transcript.ts'
import { type TuiToken } from '../../theme-tokens.ts'
import { type TuiTheme } from '../../theme.ts'
import { codeBlockLines } from '../diff.ts'
import { canFrame, frameBlock, FRAME_COLUMNS, textWidth, type FrameRow } from '../frame.ts'
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

export interface MessagesContext {
  readonly theme: TuiTheme
  readonly markdown: MarkdownRenderer
  readonly reasoningOpen: (entry: Extract<TranscriptEntry, { kind: 'reasoning' }>) => boolean
  readonly reasoningFoldHint: () => string
  readonly reasoningKey: (id: string) => string | undefined
  readonly pushWrapped: (lines: string[], text: string, width: number, prefix: string, token: TuiToken) => void
}

export class Messages {
  constructor(private readonly context: MessagesContext) {}

  /**
     * The rows one markdown message draws, with the padding pi-tui adds for background styling removed.
     *
     * The source is drawn first so the markdown renderer never measures a sequence
     * it cannot see; its own spans are applied around the result afterwards.
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
      const framed = canFrame(width, this.context.theme.visible(borderToken))
      const inside = framed ? width - FRAME_COLUMNS : width
      const body = this.markdownLines(text, textWidth(inside), live, face)
      const block = frameBlock(body, width, {
        text: line => line,
        border: rule => this.context.theme.style(borderToken, rule),
        framed,
      })
      lines.push(...block.drawn)
      copy.push(...block.copy)
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
  /** The face a submitted prompt is drawn in: its structure is markdown's, its shade stays the prompt's. */
    userFace(): MarkdownFace {
      return { name: 'user', base: { color: text => this.context.theme.style('transcript.user', text) } }
    }
  pushReasoning(lines: string[], entry: Extract<TranscriptEntry, { kind: 'reasoning' }>, width: number, spans: ClickSpan[]): void {
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
      const key = this.context.reasoningKey(entry.id)
      if (key !== undefined) spans.push({ key, start, end: lines.length, expanded: open })
    }
  /** The mark and the space that introduce an element, empty when it has none. */
    elementLead(token: TuiToken): string {
      const glyph = this.context.theme.visible(token) ? this.context.theme.glyph(token) : ''
      return glyph === '' ? '' : `${glyph} `
    }
}
