/**
 * How one tool's card draws: its header, its measured facts, the nested calls a
 * program dispatched, and the preview an opened card shows.
 *
 * Kept apart from the view that places rows because card drawing answers to the
 * presenter's own card shape and to the reader's per-tool display policy, and
 * neither of those knows about reading order or row caches.
 */
import { visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import { cardDetailRows, shellFoldHint, shellRetentionHint, type CardPreview } from '../../cards/preview.ts'
import { clip, oneLine, type CardRow, type CardStat, type CardStatKind, type ToolCard, type ToolCardKind, type ToolSubCall } from '../../cards.ts'
import { type Keymap } from '../../input/actions.ts'
import { type TranscriptEntry } from '../../transcript.ts'
import { type LiveCallState } from '../../transcript/tool-calls.ts'
import { type ToolDisplaySpec } from '../../tool-display.ts'
import { CARD_ROW_TOKEN, type TuiToken } from '../../theme-tokens.ts'
import { type TuiTheme } from '../../theme.ts'
import { type ClickSpan } from '../view.ts'

/** A nested call is a signpost under its card, so it sits one step shallower than that card's detail. */
const SUBCALL_INDENT = '  '
/**
 * Blank columns a one-line tool row keeps at the right edge.
 *
 * The cut mark would otherwise sit under the terminal's own last column, where
 * a border or the cursor lives; the padding is part of the look, not a
 * preference, so it is not a settings key.
 */
const COLLAPSED_EDGE_PADDING = 5
/**
 * The mark that says a call is in flight.
 *
 * The same arrow the dock uses for what is still to do, because it answers the
 * same question — is this work still moving — and a second symbol for it would
 * read as a second state.
 */
/** A duration below a whole second is not a measurement, so it is not drawn. */
const MIN_ELAPSED_SECONDS = 1
/** A row that a card's kind does not map draws as generic detail. */
const FALLBACK_ROW_TOKEN: TuiToken = 'tool.detail'
/** The words an opened card uses when retention, not the fold, dropped rows. */
const CARD_HINT_RETAINED = 'more lines not shown'
/** What separates a card's header from its measured facts, and the facts from each other. */
const STAT_LEAD = '  '
const STAT_SEPARATOR = ' · '
/** The symbol that says what a fact counts; a size needs none. */
const STAT_SYMBOL: Readonly<Record<CardStatKind, string>> = {
  added: '+',
  changed: '~',
  removed: '-',
  size: '',
}
/** Which colour draws each fact, so added, changed, and removed never share one. */
const STAT_TOKEN: Readonly<Record<CardStatKind, TuiToken>> = {
  added: 'tool.stat.added',
  changed: 'tool.stat.changed',
  removed: 'tool.stat.removed',
  size: 'tool.stat.size',
}
/** The column a one-line tool row must not pass, so a cut never reaches the edge. */
const collapsedEdge = (width: number): number => Math.max(1, width - COLLAPSED_EDGE_PADDING)
/** The indent a card's own detail rows sit under, one step inside the header above them. */
const DETAIL_INDENT = '    '

export interface ToolCardsContext {
  readonly theme: TuiTheme
  readonly keymap: () => Keymap
  readonly toolDisplay: (tool: string) => ToolDisplaySpec
  readonly expansionOf: (entry: Extract<TranscriptEntry, { kind: 'tool' }>) => boolean
  /**
   * Whether this card draws the calls its program dispatched.
   *
   * Read per card rather than off {@link ViewState.expandSubCalls}, because the
   * header of one card is a toggle for that card: a reader opens the program
   * they are reading, and the key is still the one press for all of them.
   */
  readonly subCallsOpen: (entry: Extract<TranscriptEntry, { kind: 'tool' }>) => boolean
  readonly liveCall: (callId: string) => LiveCallState
  readonly cardOpenHint: () => string
  readonly toolKey: (id: string) => string | undefined
  /** The key of the one card's own nested-call toggle, which only a card that dispatched calls draws. */
  readonly subCallsKey: (id: string) => string | undefined
  readonly subCallKey: (parentId: string, id: string) => string
  readonly subCallOpen: (parentId: string, id: string) => boolean
}

export class ToolCards {
  constructor(private readonly context: ToolCardsContext) {}

  /**
     * Wrap one already-styled block under a prefix.
     *
     * A card header mixes tokens — title, argument, stats — in a single string, so
     * it cannot go through {@link pushWrapped}, which escapes and restyles plain
     * text. Its width still has to fold at the screen edge rather than be cut,
     * because the argument is the part a reader scans for and a silently dropped
     * command is worse than a taller card.
     */
    private pushStyledWrapped(lines: string[], content: string, width: number, prefix: string): void {
      const lead = visibleWidth(prefix)
      const indent = ' '.repeat(lead)
      const wrapped = wrapTextWithAnsi(content, Math.max(1, width - lead))
      wrapped.forEach((line, index) => {
        lines.push(this.context.theme.cut(`${index === 0 ? prefix : indent}${line}`, width, ''))
      })
    }
  pushCard(lines: string[], entry: Extract<TranscriptEntry, { kind: 'tool' }>, width: number, spans: ClickSpan[]): void {
      const live = this.context.liveCall(entry.id)
      // The card was drawn when the call was requested, so a duration measured at
      // render time is the only clock it can be shown with: the fold holds the one
      // timestamp this window has.
      const card = this.cardOf(entry.card, live)
      const spec = this.context.toolDisplay(card.tool)
      const expanded = this.context.expansionOf(entry)
      const start = lines.length
      // What a folded card shows of its rows is the reader's choice, so a shell
      // run no longer spends twenty rows on screen just because its output is the
      // answer: the answer is one click away, and the row it costs is one.
      const preview: CardPreview = expanded
        ? { expanded: true }
        : spec.output === 'tail'
          ? { expanded: false, preview: 'tail', rows: spec.tail }
          : { expanded: false, preview: 'title' }
      const { lines: detail, hidden } = cardDetailRows(card, preview)
      const titleToken = this.titleToken(card, { running: 'tool.running.title', failed: 'tool.failed.title' })
      const glyphToken = card.failed ? 'tool.failed.glyph' : 'tool.glyph'
      if (expanded) {
        const { lead, body } = this.renderHead(card, titleToken, glyphToken)
        // A header that folds keeps the argument and its stats; a terminal command
        // can be longer than the screen, so it wraps under its own indent.
        if (body !== '') this.pushStyledWrapped(lines, body, width, lead)
      } else {
        const head = this.renderCollapsedHead(card, hidden, titleToken, glyphToken, width)
        if (head !== '') lines.push(this.context.theme.cut(head, collapsedEdge(width), '…'))
      }
      // The calls a program dispatched sit under the header whether the card is
      // open or folded: one line per call is what the card stands for, and hiding
      // them behind the card's own fold made a program's work invisible.
      const headerEnd = lines.length
      const nestedKey = card.subCalls === undefined ? undefined : this.context.subCallsKey(entry.id)
      const nested = this.context.subCallsOpen(entry)
      if (nested) this.pushSubCalls(lines, entry, width, spans)
      // Where the calls stopped, so the card's own rows are counted from below them.
      const callsEnd = lines.length
      if (expanded && card.kind === 'terminal' && card.argument !== undefined && card.argument !== '' && this.context.theme.visible('tool.args')) {
        this.pushStyledWrapped(lines, this.context.theme.rich(card.argument, { token: 'tool.args', column: visibleWidth(DETAIL_INDENT) }), width, DETAIL_INDENT)
      }
      for (const row of detail) {
        const drawn = this.detailRow(row, card.kind)
        // A row whose every part is hidden draws nothing, and nothing must not
        // cost a line: the indent would read as an empty row the card does not have.
        if (drawn === '') continue
        lines.push(this.context.theme.cut(`${DETAIL_INDENT}${drawn}`, width, ''))
      }
      // The pill is not output, so it draws after the preview window rather than
      // inside it: a run bounded to its tail still reports how it ended. Folded,
      // it rides the header instead, where it costs no row of its own.
      if (expanded && card.kind === 'terminal' && card.status !== undefined && this.context.theme.visible('tool.terminal.status')) {
        lines.push(this.context.theme.cut(`${DETAIL_INDENT}${this.context.theme.rich(card.status, { token: 'tool.terminal.status', column: visibleWidth(DETAIL_INDENT) })}`, width, ''))
      }
      // A shell card's rows are kept from the end, so a hidden count always names
      // the rows *before* what is on screen and the hint has to say so; every
      // other card keeps its head, where a neutral count is enough. A folded card
      // that shows a tail is bounded by that window, an opened one by retention,
      // so the opened hint promises no more than memory kept.
      if (hidden > 0 && this.context.theme.visible('tool.hint')) {
        const hint = preview.expanded
          ? card.kind === 'terminal' ? shellRetentionHint(hidden) : `${hidden} ${CARD_HINT_RETAINED}`
          : preview.preview === 'tail'
            ? shellFoldHint(hidden, this.context.cardOpenHint())
            : undefined
        if (hint !== undefined) {
          lines.push(this.context.theme.style('tool.hint', this.context.theme.cut(`${DETAIL_INDENT}${hint}`, width, '')))
        }
      }
      // A card that dispatched calls splits its rows between two targets: the
      // header answers for the calls one level under it, and the rows below them
      // fold the card the way every other card folds. The header stops where it
      // stopped drawing rather than at the calls, because a reader pointing at
      // what the program returned means the card, not the list above it. The call
      // rows keep the tighter targets they draw for themselves, so opening one
      // call still opens that call rather than hiding the list around it.
      const key = this.context.toolKey(entry.id)
      if (nestedKey !== undefined && headerEnd > start) {
        spans.push({ key: nestedKey, start, end: headerEnd, expanded: nested })
      }
      const cardStart = nestedKey === undefined ? start : nested ? callsEnd : headerEnd
      if (key !== undefined && lines.length > cardStart) spans.push({ key, start: cardStart, end: lines.length, expanded })
    }
  /**
     * The calls one card dispatched, one entry each.
     *
     * A nested call is a signpost rather than a card of its own, so it keeps one
     * entry per call, clipped to that entry until the reader clicks it: the
     * argument is the part a reader scans for, and one that always wrapped pushed
     * the rest of the program off the screen.
     */
    private pushSubCalls(lines: string[], entry: Extract<TranscriptEntry, { kind: 'tool' }>, width: number, spans: ClickSpan[]): void {
      const card = entry.card
      const subCalls = card.subCalls ?? []
      for (const call of subCalls) {
        const start = lines.length
        const open = this.context.subCallOpen(entry.id, call.id)
        // A program's calls are the work between its start and its return value, so
        // each row's own name says what became of it — the call still in flight in
        // the running colour, one that failed in the failed colour, and one that is
        // back in the colour every settled name is read in.
        const titleToken = this.titleToken(call, { running: 'tool.subcall.running', failed: 'tool.failed.title' })
        const column = visibleWidth(SUBCALL_INDENT)
        const title = this.context.theme.visible(titleToken) ? this.context.theme.rich(call.title, { token: titleToken, column }) : ''
        const argument = call.argument === undefined || !this.context.theme.visible('tool.subcall.args')
          ? ''
          : this.context.theme.rich(call.argument, { token: 'tool.subcall.args', column })
        // How the call ended is the tool's own line about its outcome — a shell's
        // exit status — and it is the only part of a dispatch's result that fits on
        // the one row a reader scans.
        const status = call.status === undefined || !this.context.theme.visible('tool.terminal.status')
          ? ''
          : this.context.theme.rich(call.status, { token: 'tool.terminal.status', column })
        // Joined rather than concatenated: the name and the argument are one space
        // apart whether or not either of them is drawn at all, and the outcome joins
        // the row the way it joins every other one.
        const label = [title, argument.trim()].filter(part => part !== '').join(' ')
        const drawn = [label, status].filter(part => part !== '').join(this.statSeparator())
        // A row whose every part is hidden draws nothing, and nothing must not
        // cost a line the card does not have.
        if (drawn === '') continue
        if (open) {
          this.pushStyledWrapped(lines, drawn, width, SUBCALL_INDENT)
          this.pushSubCallOutput(lines, call, width)
        } else {
          lines.push(this.context.theme.cut(`${SUBCALL_INDENT}${drawn}`, collapsedEdge(width), '…'))
        }
        spans.push({ key: this.context.subCallKey(entry.id, call.id), start, end: lines.length, expanded: open })
      }
      const hidden = (card.subCallsTotal ?? subCalls.length) - subCalls.length
      if (hidden > 0 && this.context.theme.visible('tool.hint')) {
        lines.push(this.context.theme.style('tool.hint', this.context.theme.cut(`${SUBCALL_INDENT}… ${hidden} more calls`, width, '')))
      }
    }
  /**
     * What a dispatched call declared and what it produced, under its argument.
     *
     * The parent card keeps only the program's return value, so both are otherwise
     * gone; a reader who opens the row is asking for them, which is why the call's
     * own rows come first and its outcome under them. Each section keeps the
     * retention its card used, so a long run still says what it dropped.
     */
    private pushSubCallOutput(lines: string[], call: ToolSubCall, width: number): void {
      for (const section of [call.presented, call.output]) {
        if (section === undefined) continue
        for (const row of section.rows) {
          const drawn = this.detailRow(row, section.kind)
          if (drawn === '') continue
          lines.push(this.context.theme.cut(`${DETAIL_INDENT}${drawn}`, width, ''))
        }
        const hidden = section.totalLines - section.rows.length
        if (hidden > 0 && this.context.theme.visible('tool.hint')) {
          // A shell's rows are kept from the end, so its hidden count names the
          // earlier lines; every other kind keeps its head, where the count is of
          // what follows and a neutral wording is what the card uses too.
          const hint = section.kind === 'terminal' ? shellRetentionHint(hidden) : `${hidden} ${CARD_HINT_RETAINED}`
          lines.push(this.context.theme.style('tool.hint', this.context.theme.cut(`${DETAIL_INDENT}${hint}`, width, '')))
        }
      }
    }
  /**
     * A folded card's one row: label, clipped argument, measured facts, outcome.
     *
     * The outcome rides this row rather than a row of its own, because one line
     * per call is what folding promises. A shell card's hidden rows are counted
     * here too: its output is the answer the reader asked for, and a fold that
     * left no trace of it would read as a call that produced nothing.
     *
     * The argument is the part that gives up room: it is clipped to whatever the
     * label, the facts, and the outcome leave before the edge, so a wide terminal
     * shows more of the call while a narrow one still shows how it ended.
     */
    private renderCollapsedHead(card: ToolCard, hidden: number, titleToken: TuiToken, glyphToken: TuiToken, width: number): string {
      const edge = collapsedEdge(width)
      const lead = this.cardLead(titleToken, glyphToken)
      const title = this.cardTitle(card, titleToken)
      const separator = this.statSeparator()
      // One row is what folding promises, so a running call reports its duration
      // on the same line rather than costing a row of its own.
      const elapsed = this.elapsedStat(card)
      // The facts carry their own lead; the outcome and the count join whatever
      // precedes them, so the folded line reads as one sentence about the run.
      let tail = this.renderStats(card.stats)
      const status = card.kind === 'terminal' && card.status !== undefined && this.context.theme.visible('tool.terminal.status')
        ? this.context.theme.rich(card.status, { token: 'tool.terminal.status' })
        : ''
      if (status !== '') tail += `${separator}${status}`
      if (card.kind === 'terminal' && hidden > 0) {
        const count = this.renderStats([{ kind: 'size', text: `${hidden} line${hidden === 1 ? '' : 's'}` }], '')
        if (count !== '') tail += `${separator}${count}`
      }
      if (elapsed !== '') tail += `${separator}${elapsed}`
      const fixed = visibleWidth(lead) + visibleWidth(title) + visibleWidth(tail)
      const room = Math.max(0, edge - fixed - (title === '' ? 0 : 1))
      const argument = room > 0 ? this.cardArgument(card, room) : ''
      const head = [title, argument].filter(part => part !== '').join(' ')
      // A row with no visible label or argument opens with the tail, and a line
      // that begins with a separator reads as a row that lost its first word.
      if (head === '' && tail.startsWith(separator)) tail = tail.slice(separator.length)
      return `${lead}${head}${tail}`
    }
  /**
     * One detail row, drawn with its own kind's colours or nothing at all.
     *
     * The row says what it is, so the renderer never guesses from the text: a diff
     * line beginning with "+" is an addition because the presenter said so, not
     * because of its first character.
     */
    private detailRow(row: CardRow, kind: ToolCardKind): string {
      return row.parts
        .map(part => {
          const token = CARD_ROW_TOKEN[kind]?.[part.class] ?? FALLBACK_ROW_TOKEN
          return this.context.theme.visible(token) ? this.context.theme.rich(part.text, { token, column: visibleWidth(DETAIL_INDENT) }) : ''
        })
        .join('')
    }
  /** The mark that introduces a card, empty when the theme hides its label. */
    private cardLead(titleToken: TuiToken, glyphToken: TuiToken): string {
      return this.context.theme.visible(titleToken) ? this.context.theme.glyph(glyphToken) : ''
    }
  /** A card's label, styled, or nothing when the theme hides it. */
    private cardTitle(card: ToolCard, titleToken: TuiToken): string {
      return this.context.theme.visible(titleToken) ? this.context.theme.rich(card.title, { token: titleToken }) : ''
    }
  /** A card's argument, styled and flattened, clipped to `limit` when one is given. */
    private cardArgument(card: ToolCard, limit?: number): string {
      if (card.argument === undefined || card.argument === '' || !this.context.theme.visible('tool.args')) return ''
      const shown = limit === undefined ? card.argument : clip(oneLine(card.argument), limit)
      return this.context.theme.rich(shown, { token: 'tool.args' })
    }
  /**
     * A card's header: its label, its argument, and its measured facts.
     *
     * The glyph is returned apart from the body so a wrapped continuation can
     * align under the label rather than under the mark. An opened terminal's
     * argument is left out because it needs a row of its own — it is the one
     * argument that can be a whole command rather than a word.
     */
    private renderHead(card: ToolCard, titleToken: TuiToken, glyphToken: TuiToken): { lead: string; body: string } {
      const lead = this.cardLead(titleToken, glyphToken)
      const title = this.cardTitle(card, titleToken)
      const argument = card.kind === 'terminal' ? '' : this.cardArgument(card)
      const head = [title, argument].filter(part => part !== '').join(' ')
      const stats = this.renderStats(card.stats)
      const elapsed = this.elapsedStat(card)
      return { lead, body: `${head}${stats}${elapsed === '' ? '' : `${this.statSeparator()}${elapsed}`}` }
    }
  /**
     * The colour a call's name is drawn in, which is the whole of its state.
     *
     * The name is where a reader looking for a call looks first, so what that call
     * is doing belongs in the name rather than in a glyph beside it: one name, in
     * the colour of its state, and nothing a reader has to learn to read first.
     *
     * A state is only how a name is painted, though, so a reader who turns one of
     * these colours off still gets the name: hiding a state token takes the colour
     * away, not the word it was painted on.
     */
    private titleToken(
      state: { readonly running?: boolean; readonly failed: boolean },
      tokens: { readonly running: TuiToken; readonly failed: TuiToken },
    ): TuiToken {
      if (state.failed) return this.context.theme.visible(tokens.failed) ? tokens.failed : 'tool.title'
      if (state.running === true) return this.context.theme.visible(tokens.running) ? tokens.running : 'tool.title'
      return 'tool.title'
    }
  /**
     * The seconds a call has taken: counting while it is unanswered, and kept on
     * the card of a program that dispatched calls.
     *
     * A plain tool's duration is not worth the width once its outcome is on the
     * row, but a program is a thing that took time, and the reader who watched the
     * timer count wants the total it ended on — quietly, since the work is over.
     */
    private elapsedStat(card: ToolCard): string {
      const seconds = card.elapsed ?? 0
      if (seconds < MIN_ELAPSED_SECONDS) return ''
      const token: TuiToken | undefined = card.running === true
        ? 'tool.running.elapsed'
        : this.dispatchedCalls(card)
          ? 'tool.elapsed.done'
          : undefined
      if (token === undefined || !this.context.theme.visible(token)) return ''
      return this.context.theme.style(token, `${STAT_SYMBOL.changed}${seconds}s`)
    }
  /**
     * Whether this card drew calls a program dispatched.
     *
     * The child rows are the fold's own statement that the card is a program's, so
     * the view never has to know the name of the tool that runs one.
     */
    private dispatchedCalls(card: ToolCard): boolean {
      return card.subCalls !== undefined
    }
  /**
     * The card as this frame reads it, with its elapsed time filled in.
     *
     * The entry itself is left alone: the rows are cached by entry identity, so
     * rewriting one every second to carry a number that changes every second would
     * discard the rows of a call that has been waiting all along.
     */
    private cardOf(card: ToolCard, live: LiveCallState): ToolCard {
      if (!live.running || card.running === true) return card
      return { ...card, running: true, elapsed: live.elapsed }
    }
  /** The separator a header uses between its label, its facts, and its outcome. */
    private statSeparator(): string {
      return this.context.theme.style('tool.stat.separator', STAT_SEPARATOR)
    }
  /**
     * The measured facts, each in its own colour, or nothing when none is visible.
     *
     * The lead is a parameter because a header that already carries a title and an
     * argument separates its facts with the same mark as its outcome, while facts
     * on a row of their own stand apart with blank columns.
     */
    private renderStats(stats: readonly CardStat[] | undefined, lead = STAT_LEAD): string {
      if (stats === undefined || stats.length === 0) return ''
      const drawn = stats
        .filter(stat => this.context.theme.visible(STAT_TOKEN[stat.kind]))
        .map(stat => this.context.theme.rich(`${STAT_SYMBOL[stat.kind]}${stat.text}`, { token: STAT_TOKEN[stat.kind] }))
      if (drawn.length === 0) return ''
      return `${lead}${drawn.join(this.statSeparator())}`
    }
}
