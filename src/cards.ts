
import { type CardRowClass } from './theme-tokens.ts'
import { clipVisibleGraphemes } from './terminal-text.ts'

/** What a tool's result presenter receives, plus the call arguments it was asked with. */
export interface ToolResultInput {
  readonly argumentsJson: string
  readonly content: unknown
  readonly isError: boolean
  readonly meta: unknown
}

/**
 * How the surface asks a tool to present itself.
 *
 * The seam is a plain interface so the transcript fold stays pure: the host
 * adapter is the only part that touches the tool registry.
 */
export interface ToolPresenter {
  call(name: string, argumentsJson: string): ToolCard | undefined
  result(name: string, input: ToolResultInput): ToolCard | undefined
}

/** Which treatment a card gets; mirrors the tool's declared render intent. */
export type ToolCardKind = 'generic' | 'terminal' | 'diff' | 'search' | 'read' | 'web'

/**
 * One styled fragment of a detail row.
 *
 * A row such as `12: text` is two things to a reader — a line number and the
 * line — so a row carries fragments rather than one string. Anything else
 * would make the line-number styles into settings that never apply.
 */
export interface CardPart {
  readonly class: CardRowClass
  readonly text: string
}

/** One detail row, as the fragments a renderer draws in order. */
export interface CardRow {
  readonly parts: readonly CardPart[]
}

/** A row drawn in a single style. */
export function cardRow(cls: CardRowClass, text: string): CardRow {
  return { parts: [{ class: cls, text }] }
}

/** The words of a row with no styling, for callers that only need the text. */
export function rowText(row: CardRow): string {
  return row.parts.map(part => part.text).join('')
}

/** What a measured fact on a card is, which decides its colour and symbol. */
export type CardStatKind = 'added' | 'changed' | 'removed' | 'size'

/** One measured fact a card reports beside its header, e.g. a change or size count. */
export interface CardStat {
  readonly kind: CardStatKind
  /** The number or phrase; the renderer supplies the symbol and the styling. */
  readonly text: string
}

/**
 * One nested call a PTC program dispatched, as the single row it draws.
 *
 * The row is the tool's own call header — the title and the salient argument
 * its presenter declared — so the surface still learns no tool name.
 */
export interface ToolSubCall {
  /**
   * The dispatch's own id.
   *
   * The row is redrawn from the parent card on every fold, so the id is what
   * keeps a reader's click on this call instead of on whatever lands next.
   */
  readonly id: string
  readonly title: string
  readonly argument?: string
  readonly failed: boolean
  /**
   * Whether the call is dispatched and still running.
   *
   * A program's calls are the only work a reader sees between the moment the
   * program starts and its return value, so a call that has settled already and
   * one still in flight have to be told apart: the card they sit under is one
   * row either way until the program comes back.
   */
  readonly running: boolean
  /**
   * How the call finished, in the words the tool that ran it reported.
   *
   * A program's calls all look alike once they are back, so the row keeps the
   * one line the tool itself drew about its outcome — a shell's exit status — and
   * a reader can tell a command that worked from one that did not without
   * opening anything.
   */
  readonly status?: string
  /**
   * What the tool's own presenter drew for the call — a diff derived from the
   * arguments, a raw input — kept only for the reader who opens the row.
   *
   * A call that failed carries none: the change it declared never happened, and
   * rows that still drew as applied would say otherwise.
   */
  readonly presented?: ToolSubCallRows
  /** What the call's outcome presented, of whatever kind, kept for the same reader. */
  readonly output?: ToolSubCallRows
}

/**
 * One section of rows a dispatched call opens to.
 *
 * A program answers with its own return value, so both what a call declared and
 * what it produced are otherwise gone; a reader opening one of those rows is
 * asking for exactly this, and the row it belongs to is where it must live.
 */
export interface ToolSubCallRows {
  /** The view kind that drew the rows, so they use that tool's colours. */
  readonly kind: ToolCardKind
  /** Rows retained for rendering, already capped at CARD_DETAIL_MAX. */
  readonly rows: readonly CardRow[]
  /** Rows the card was presented with, which retention may have cut short. */
  readonly totalLines: number
}

/** One renderable tool row: a header plus the detail rows kept for rendering. */
export interface ToolCard {
  readonly kind: ToolCardKind
  /**
   * The tool this card belongs to, as the registry names it.
   *
   * Display policy is configured per tool, and the title cannot stand in for
   * the name: a presenter may replace its title with anything, while the name
   * is what the reader writes in settings.
   */
  readonly tool: string
  /**
   * The card's label: the tool's own name when it has an argument, else the
   * title its presenter declared.
   */
  readonly title: string
  /**
   * The salient argument the call was made with — a path or a command.
   *
   * The surface cannot know which argument matters, so the presenter names it
   * through its locations or its terminal title. It is a field rather than part
   * of the title so it can carry its own colour, and it is drawn outside the
   * fold because what ran is never a detail.
   */
  readonly argument?: string
  /** Measured facts to report beside the header, e.g. changed or read lines. */
  readonly stats?: readonly CardStat[]
  /**
   * The exit pill of a terminal card, drawn outside the fold with its output.
   *
   * The pill is not output, so it must not consume a slot of the folded preview
   * window nor be the first row a bounded tail drops.
   */
  readonly status?: string
  /** Rows retained for rendering, already capped at CARD_DETAIL_MAX. */
  readonly detail: readonly CardRow[]
  readonly failed: boolean
  /**
   * Whether the call is logged and still unanswered, filled in at draw time.
   *
   * The surface is told when a call is requested and when its result lands, and
   * nothing in between: between those two events the call is what the model is
   * waiting on, which is the one thing a reader watching a long run needs to see.
   * Only a frame sets these, and it sets them on a copy of the folded card, so a
   * stored card never claims a call that has since answered is still running.
   */
  readonly running?: boolean
  /** Whole seconds the call has been in flight, drawn only while it is. */
  readonly elapsed?: number
  /** Rows the tool actually presented, which retention may have cut short. */
  readonly totalLines: number
  /**
   * The calls a PTC program dispatched through this card, in dispatch order.
   *
   * A program reaches every tool through one card, so those calls are the
   * card's own children rather than rows of their own, capped the way detail
   * rows are.
   */
  readonly subCalls?: readonly ToolSubCall[]
  /** Calls the program dispatched at all, which retention may have cut short. */
  readonly subCallsTotal?: number
}

/**
 * Detail rows retained on a card at all.
 *
 * A collapse key must be able to show more than the summary does, and a tool
 * that prints a hundred thousand lines must not keep the whole transcript in
 * memory for a reader who will never scroll that far.
 */
export const CARD_DETAIL_MAX = 200

/** Character budget for one detail row, so a minified file cannot flood the viewport. */
export const CARD_LINE_LIMIT = 200

/**
 * Cut text to a character budget, marking the cut.
 *
 * Counted in grapheme clusters rather than display cells: the budget is the
 * reader's own setting, while the renderer still cuts and wraps what it draws by
 * width. A cluster is also the smallest run a cut may drop, so a joined emoji
 * survives the budget whole instead of being halved by it. Terminal sequences
 * are not content, so they are not counted and never cut through: a coloured
 * row keeps as many words as a plain one.
 */
export function clip(text: string, limit: number): string {
  if (limit <= 0) return ''
  return clipVisibleGraphemes(text, limit)
}

export function clipLine(text: string): string {
  return clip(text, CARD_LINE_LIMIT)
}

/**
 * Text on one row, with every run of whitespace collapsed.
 *
 * A command may carry newlines, and a folded card promises exactly one row: a
 * wrapped continuation would make one card read as two.
 */
export function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

function clipRow(row: CardRow): CardRow {
  return { parts: row.parts.map(part => ({ class: part.class, text: clipLine(part.text) })) }
}

export function bound(rows: readonly CardRow[]): { detail: CardRow[]; totalLines: number } {
  return { detail: rows.slice(0, CARD_DETAIL_MAX).map(clipRow), totalLines: rows.length }
}

/**
 * Bound a card to its retained rows from the END.
 *
 * A command's answer is its last lines, so keeping the head would show a long
 * run's middle and lose the ending the reader asked for; the tail is also what
 * a folded shell card tails again.
 */
export function boundTail(rows: readonly CardRow[]): { detail: CardRow[]; totalLines: number } {
  return { detail: rows.slice(-CARD_DETAIL_MAX).map(clipRow), totalLines: rows.length }
}

/**
 * Build a card from raw text lines.
 *
 * Every path that turns text into a card goes through here, so a tool with no
 * presenter — or a result whose presenter declined — cannot keep a hundred
 * thousand lines alive in the transcript.
 */
export function cardFromLines(
  kind: ToolCardKind,
  tool: string,
  title: string,
  lines: readonly string[],
  failed: boolean,
): ToolCard {
  const bounded = bound(lines.map(line => cardRow('detail', line)))
  return { kind, tool, title, detail: bounded.detail, failed, totalLines: bounded.totalLines }
}

/** Text lines carried by model-facing content blocks. */
export function contentLines(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  const lines: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as Record<string, unknown>
    // Any block that carries text counts; a tool-result block also holds its
    // model-facing content one level deeper.
    if (typeof record.text === 'string') lines.push(...record.text.split('\n'))
    if (Array.isArray(record.content)) lines.push(...contentLines(record.content))
  }
  return lines
}
