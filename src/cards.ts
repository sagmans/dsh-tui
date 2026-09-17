import type {
  DiffCallView,
  DiffResultView,
  FileDiff,
  GenericCallView,
  GenericResultView,
  ReadResultView,
  SearchResultView,
  TerminalCallView,
  TerminalResultView,
  ToolCallView,
  ToolResultView,
  WebResultView,
} from '@deepseek-ai/dsh-tools'
import type { CardRowClass } from './theme-tokens.ts'
import { countTokens, formatTokens } from './tokens.ts'

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

/** One renderable tool row: a header plus the detail rows kept for rendering. */
export interface ToolCard {
  readonly kind: ToolCardKind
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
  /** Rows the tool actually presented, which retention may have cut short. */
  readonly totalLines: number
}

/**
 * Detail rows retained on a card at all.
 *
 * A collapse key must be able to show more than the summary does, and a tool
 * that prints a hundred thousand lines must not keep the whole transcript in
 * memory for a reader who will never scroll that far.
 */
export const CARD_DETAIL_MAX = 200

/**
 * Output rows a folded shell card keeps on screen, counted from the end.
 *
 * A shell command is the one card whose output is the result the reader asked
 * for, so folding it to its header would hide the answer. The tail is the part
 * that carries the outcome of a long run, and the retention cap still bounds
 * what ctrl+o can reveal.
 */
export const CARD_SHELL_PREVIEW = 20

/**
 * The tail of the hint a folded shell card draws when it dropped rows.
 *
 * "more" rather than "them": retention caps detail rows, so a command that
 * printed thousands of lines cannot promise ctrl+o will reveal every dropped
 * one.
 */
const CARD_HINT_EARLIER = 'earlier lines · ctrl+o shows more'

/** Character budget for one detail row, so a minified file cannot flood the viewport. */
export const CARD_LINE_LIMIT = 200

function clipLine(text: string): string {
  return text.length <= CARD_LINE_LIMIT ? text : `${text.slice(0, CARD_LINE_LIMIT - 1)}…`
}

function clipRow(row: CardRow): CardRow {
  return { parts: row.parts.map(part => ({ class: part.class, text: clipLine(part.text) })) }
}

function bound(rows: readonly CardRow[]): { detail: CardRow[]; totalLines: number } {
  return { detail: rows.slice(0, CARD_DETAIL_MAX).map(clipRow), totalLines: rows.length }
}

/**
 * Bound a card to its retained rows from the END.
 *
 * A command's answer is its last lines, so keeping the head would show a long
 * run's middle and lose the ending the reader asked for; the tail is also what
 * a folded shell card tails again.
 */
function boundTail(rows: readonly CardRow[]): { detail: CardRow[]; totalLines: number } {
  return { detail: rows.slice(-CARD_DETAIL_MAX).map(clipRow), totalLines: rows.length }
}

/** How many lines a text holds, ignoring the newline that only terminates the last one. */
function lineCount(text: string): number {
  const trimmed = text.replace(/\n+$/, '')
  return trimmed === '' ? 0 : trimmed.split('\n').length
}

/**
 * The size of a text a card presents, in lines and in tokens.
 *
 * A reader deciding whether to open a file cares about both: lines say how tall
 * it is, tokens say what it cost to put in the conversation.
 */
function sizeStats(text: string): readonly CardStat[] {
  const lines = lineCount(text)
  const tokens = countTokens(text.replace(/\n+$/, ''))
  const stats: CardStat[] = []
  if (lines > 0) stats.push({ kind: 'size', text: `${lines} line${lines === 1 ? '' : 's'}` })
  if (tokens > 0) stats.push({ kind: 'size', text: `${formatTokens(tokens)} tok` })
  return stats
}

/**
 * A file change's split into added, changed, and removed lines.
 *
 * A replacement is one changed line, not an add plus a remove, so the smaller
 * of the two sides is the changed count and only the excess counts as pure
 * additions or deletions — otherwise every edit reads as twice its size.
 */
function changeStats(diffs: readonly FileDiff[]): readonly CardStat[] {
  let added = 0
  let removed = 0
  for (const diff of diffs) {
    for (const row of renderFileDiff(diff)) {
      const cls = row.parts[0]?.class
      if (cls === 'added') added += 1
      else if (cls === 'removed') removed += 1
    }
  }
  const changed = Math.min(added, removed)
  const stats: CardStat[] = []
  if (added - changed > 0) stats.push({ kind: 'added', text: String(added - changed) })
  if (changed > 0) stats.push({ kind: 'changed', text: String(changed) })
  if (removed - changed > 0) stats.push({ kind: 'removed', text: String(removed - changed) })
  return stats
}

/** The window a read returned: its line range, how many lines, and their token size. */
function readStats(read: ReadResultView): readonly CardStat[] {
  if (read.lines.length === 0) return [{ kind: 'size', text: '0 lines' }]
  const start = read.offset
  const end = read.offset + read.lines.length - 1
  const count = read.lines.length
  const stats: CardStat[] = [
    { kind: 'size', text: start === end ? `L${start}` : `L${start}–${end}` },
    { kind: 'size', text: `${count} line${count === 1 ? '' : 's'}` },
  ]
  const tokens = countTokens(read.lines.map(line => line.text).join('\n'))
  if (tokens > 0) stats.push({ kind: 'size', text: `${formatTokens(tokens)} tok` })
  return stats
}

/** A diff's measured facts: a creation reports its size, an edit its line changes. */
function diffStats(diffs: readonly FileDiff[]): readonly CardStat[] {
  const created = diffs.length > 0 && diffs.every(diff => diff.oldText === null)
  return created ? sizeStats(diffs.map(diff => diff.newText).join('\n')) : changeStats(diffs)
}

/**
 * How much of a card the reader has asked for.
 *
 * The folded state names its own treatment because the two kinds of card are
 * not equally readable folded: a shell card's output is the answer, while every
 * other card's rows restate what its title already says.
 */
export type CardPreview =
  | { readonly expanded: true }
  | { readonly expanded: false; readonly preview: 'title' | 'shellTail' }

/**
 * The rows a card shows right now, and how many the reader is not seeing.
 *
 * Expansion is a view decision rather than a card field so one key press can
 * change every card at once without rebuilding the transcript.
 */
export function cardDetailRows(card: ToolCard, preview: CardPreview): { lines: readonly CardRow[]; hidden: number } {
  const lines = preview.expanded
    ? card.detail.slice(0, CARD_DETAIL_MAX)
    : preview.preview === 'shellTail'
      ? card.detail.slice(-CARD_SHELL_PREVIEW)
      : []
  return { lines, hidden: Math.max(0, card.totalLines - lines.length) }
}

/** The hint row for a folded shell card, or undefined when it dropped nothing. */
export function shellPreviewHint(hidden: number): string | undefined {
  return hidden <= 0 ? undefined : `… ${hidden} ${CARD_HINT_EARLIER}`
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
  title: string,
  lines: readonly string[],
  failed: boolean,
): ToolCard {
  const bounded = bound(lines.map(line => cardRow('detail', line)))
  return { kind, title, detail: bounded.detail, failed, totalLines: bounded.totalLines }
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

/**
 * Collapse one call and its result into the single row the reader sees.
 *
 * The pending row already told the reader what the tool is doing, so the
 * settled row keeps that header and swaps in the outcome; a result that
 * presents nothing keeps the call's detail rather than blanking the row.
 */
export function mergeCards(call: ToolCard | undefined, result: ToolCard | undefined): ToolCard {
  const base = call ?? result
  if (base === undefined) throw new Error('mergeCards requires at least one card')
  if (call === undefined || result === undefined) return base
  const kind = result.kind === 'generic' ? call.kind : result.kind
  // The result, when it names one, knows the argument that was actually acted
  // on; a terminal result omits it, so the pending call's command is kept. The
  // result also owns the measured facts, because only it knows the outcome.
  const argument = result.argument ?? call.argument
  const stats = result.stats ?? call.stats
  const status = result.status ?? call.status
  return {
    kind,
    title: call.title,
    ...(argument === undefined ? {} : { argument }),
    ...(stats === undefined ? {} : { stats }),
    ...(status === undefined ? {} : { status }),
    detail: result.detail.length > 0 ? result.detail : call.detail,
    failed: result.failed,
    totalLines: result.detail.length > 0 ? result.totalLines : call.totalLines,
  }
}

/**
 * Render one file change as a bounded unified hunk.
 *
 * Only the changed middle is shown: a presenter has the prior and next text but
 * no hunk list, so trimming the shared prefix and suffix yields the same region
 * a full diff would highlight without paying for a line-diff computation on
 * every frame.
 */
export function renderFileDiff(diff: FileDiff): CardRow[] {
  const before = diff.oldText === null ? [] : diff.oldText.split('\n')
  const after = diff.newText.split('\n')
  let head = 0
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1
  let tail = 0
  while (
    tail < before.length - head
    && tail < after.length - head
    && before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) tail += 1
  const removed = before.slice(head, before.length - tail)
  const added = after.slice(head, after.length - tail)
  // "new" keys off the absent prior text, not off an empty hunk: an unchanged
  // file has no removals either and must not read as a creation.
  const header = diff.oldText === null ? 'new' : `-${removed.length} +${added.length}`
  const rows: CardRow[] = [cardRow('header', `${diff.path}  ${header}`)]
  if (head > 0) rows.push(cardRow('hunk', `@@ ${head} unchanged line${head === 1 ? '' : 's'} before`))
  for (const line of removed) rows.push(cardRow('removed', `-${line}`))
  for (const line of added) rows.push(cardRow('added', `+${line}`))
  if (tail > 0) rows.push(cardRow('hunk', `@@ ${tail} unchanged line${tail === 1 ? '' : 's'} after`))
  return rows
}

function title(view: { title?: string }, fallback: string): string {
  const declared = view.title?.trim() ?? ''
  return declared === '' ? fallback : declared
}

/** A read line keeps its number apart from its text, because they read differently. */
function readLine(number: number, text: string): CardRow {
  return { parts: [{ class: 'lineNumber', text: `${number}:` }, { class: 'line', text: ` ${text}` }] }
}

/** A search hit keeps its location apart from the matching line. */
function searchHit(path: string, lineNumber: number, line: string): CardRow {
  return {
    parts: [
      { class: 'path', text: path },
      { class: 'lineNumber', text: `:${lineNumber}:` },
      { class: 'match', text: ` ${line}` },
    ],
  }
}

/** Map a tool's pending-call intent to a card, falling back to the raw call name. */
export function cardOfCall(view: ToolCallView | undefined, fallbackName: string): ToolCard {
  if (view === undefined) {
    return { kind: 'generic', title: fallbackName, detail: [], failed: false, totalLines: 0 }
  }
  switch (view.card) {
    case 'terminal': {
      const terminal = view as TerminalCallView
      const rows: CardRow[] = []
      if (terminal.description !== undefined && terminal.description !== '') rows.push(cardRow('output', terminal.description))
      if (terminal.cwd !== undefined && terminal.cwd !== '') rows.push(cardRow('cwd', `cwd ${terminal.cwd}`))
      // The header names the tool so the command can sit on its own row: a
      // terminal view's own title IS the command, and a fold must not hide it.
      const command = terminal.title?.trim() ?? ''
      return {
        kind: 'terminal',
        title: fallbackName,
        ...(command === '' ? {} : { argument: command }),
        detail: bound(rows).detail,
        failed: false,
        totalLines: 0,
      }
    }
    case 'diff': {
      const diff = view as DiffCallView
      const bounded = bound(diff.diffs.flatMap(renderFileDiff))
      const path = diff.diffs[0]?.path
      if (path === undefined || path === '') {
        return { kind: 'diff', title: title(diff, fallbackName), detail: bounded.detail, failed: false, totalLines: bounded.totalLines }
      }
      return {
        kind: 'diff',
        title: fallbackName,
        argument: path,
        detail: bounded.detail,
        failed: false,
        totalLines: bounded.totalLines,
      }
    }
    default: {
      const generic = view as GenericCallView
      const lines = contentLines(generic.content)
      if (generic.rawInput !== undefined && lines.length === 0) {
        lines.push(typeof generic.rawInput === 'string' ? generic.rawInput : JSON.stringify(generic.rawInput))
      }
      const bounded = bound(lines.map(line => cardRow('detail', line)))
      // A call that names a file has an argument worth its own colour; one that
      // does not keeps its declared title, which is already the label.
      const location = generic.locations?.[0]?.path
      if (location === undefined || location === '') {
        return { kind: 'generic', title: title(generic, fallbackName), detail: bounded.detail, failed: false, totalLines: bounded.totalLines }
      }
      return {
        kind: 'generic',
        title: fallbackName,
        argument: location,
        detail: bounded.detail,
        failed: false,
        totalLines: bounded.totalLines,
      }
    }
  }
}

/** Map a tool's result intent to a card, falling back to the model-facing text. */
export function cardOfResult(
  view: ToolResultView | undefined,
  input: { readonly fallbackTitle: string; readonly failed: boolean; readonly contentLines: readonly string[] },
): ToolCard {
  const failed = input.failed
  if (view === undefined) {
    const bounded = bound(input.contentLines.map(line => cardRow('detail', line)))
    return { kind: 'generic', title: input.fallbackTitle, detail: bounded.detail, failed, totalLines: bounded.totalLines }
  }
  switch (view.card) {
    case 'terminal': {
      const terminal = view as TerminalResultView
      // A terminating newline is the shell's, not a row: keeping it would spend
      // one slot of the preview window on a blank line the renderer then drops.
      const raw = (terminal.output ?? '').replace(/\n+$/, '')
      const rows = raw === '' ? [] : raw.split('\n').map(line => cardRow('output', line))
      const status = terminal.signal !== undefined && terminal.signal !== ''
        ? `signal ${terminal.signal}`
        : terminal.exitCode === undefined ? undefined : `exit ${terminal.exitCode}`
      // The output is bounded from its END: a command that printed far more
      // than retention keeps must still show how it finished, and the folded
      // preview tails what is retained again.
      const bounded = boundTail(rows)
      // A terminal result mostly omits the title, because the pending call
      // already carried the command; it is only a fallback for a resumed fold
      // that never saw the call.
      const command = terminal.title?.trim() ?? ''
      return {
        kind: 'terminal',
        title: input.fallbackTitle,
        ...(command === '' ? {} : { argument: command }),
        ...(status === undefined ? {} : { status }),
        detail: bounded.detail,
        failed,
        totalLines: bounded.totalLines,
      }
    }
    case 'diff': {
      const diff = view as DiffResultView
      const bounded = bound(diff.diffs.flatMap(renderFileDiff))
      const path = diff.diffs[0]?.path
      const stats = diffStats(diff.diffs)
      if (path === undefined || path === '') {
        return {
          kind: 'diff',
          title: title(diff, input.fallbackTitle),
          ...(stats.length === 0 ? {} : { stats }),
          detail: bounded.detail,
          failed,
          totalLines: bounded.totalLines,
        }
      }
      return {
        kind: 'diff',
        title: input.fallbackTitle,
        argument: path,
        ...(stats.length === 0 ? {} : { stats }),
        detail: bounded.detail,
        failed,
        totalLines: bounded.totalLines,
      }
    }
    case 'search': {
      const search = view as SearchResultView
      const rows = search.shape === 'paths'
        ? search.paths.map(path => cardRow('path', path))
        : search.files.flatMap(file => file.matches.map(match => searchHit(file.path, match.lineNumber, match.line)))
      if (search.truncated) rows.push(cardRow('truncated', `… ${search.total} total`))
      const bounded = bound(rows)
      return { kind: 'search', title: title(search, input.fallbackTitle), detail: bounded.detail, failed, totalLines: bounded.totalLines }
    }
    case 'read': {
      const read = view as ReadResultView
      // The header now carries the path and the size stats, so the detail rows
      // are only the numbered lines themselves.
      const rows: CardRow[] = []
      if (read.lines.length > 0) {
        for (const line of read.lines) rows.push(readLine(line.number, line.text))
      } else {
        for (const line of contentLines(read.content)) rows.push(cardRow('line', line))
      }
      const bounded = bound(rows)
      const stats = readStats(read)
      return {
        kind: 'read',
        title: input.fallbackTitle,
        ...(read.path === '' ? {} : { argument: read.path }),
        ...(stats.length === 0 ? {} : { stats }),
        detail: bounded.detail,
        failed,
        totalLines: bounded.totalLines,
      }
    }
    case 'web': {
      const web = view as WebResultView
      const rows: CardRow[] = []
      if (web.kind === 'search') {
        if (web.answer !== undefined && web.answer !== '') {
          for (const line of web.answer.split('\n')) rows.push(cardRow('detail', line))
        }
        for (const source of web.sources) {
          rows.push(cardRow('source', source.title === undefined ? source.url : `${source.title} — ${source.url}`))
        }
        if (web.truncated) rows.push(cardRow('truncated', '… more sources'))
      } else {
        rows.push(cardRow('url', `${web.url} → ${web.statusCode}`))
        if (web.truncated) rows.push(cardRow('truncated', '… body truncated'))
      }
      const bounded = bound(rows)
      return { kind: 'web', title: title(web, input.fallbackTitle), detail: bounded.detail, failed, totalLines: bounded.totalLines }
    }
    default: {
      const generic = view as GenericResultView
      const lines = contentLines(generic.content)
      const chosen = lines.length > 0 ? lines : input.contentLines
      const bounded = bound(chosen.map(line => cardRow('detail', line)))
      return { kind: 'generic', title: title(generic, input.fallbackTitle), detail: bounded.detail, failed, totalLines: bounded.totalLines }
    }
  }
}
