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

/** One renderable tool row: a header plus the detail rows kept for rendering. */
export interface ToolCard {
  readonly kind: ToolCardKind
  readonly title: string
  /** Rows retained for rendering, already capped at CARD_DETAIL_MAX. */
  readonly detail: readonly string[]
  readonly failed: boolean
  /** Rows the tool actually presented, which retention may have cut short. */
  readonly totalLines: number
}

/** Detail rows a settled card shows before it is summarized. */
export const CARD_DETAIL_LIMIT = 10

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

function clipLine(text: string): string {
  return text.length <= CARD_LINE_LIMIT ? text : `${text.slice(0, CARD_LINE_LIMIT - 1)}…`
}

function bound(lines: readonly string[]): { detail: string[]; totalLines: number } {
  return { detail: lines.slice(0, CARD_DETAIL_MAX).map(clipLine), totalLines: lines.length }
}

/**
 * The rows a card shows right now, and how many the reader is not seeing.
 *
 * Expansion is a view decision rather than a card field so one key press can
 * change every card at once without rebuilding the transcript.
 */
export function cardDetailRows(card: ToolCard, expanded: boolean): { lines: readonly string[]; hidden: number } {
  const lines = card.detail.slice(0, expanded ? CARD_DETAIL_MAX : CARD_DETAIL_LIMIT)
  return { lines, hidden: Math.max(0, card.totalLines - lines.length) }
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
  return {
    kind: result.kind === 'generic' ? call.kind : result.kind,
    title: call.title,
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
export function renderFileDiff(diff: FileDiff): string[] {
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
  const lines: string[] = [`${diff.path}  ${header}`]
  if (head > 0) lines.push(`@@ ${head} unchanged line${head === 1 ? '' : 's'} before`)
  for (const line of removed) lines.push(`-${line}`)
  for (const line of added) lines.push(`+${line}`)
  if (tail > 0) lines.push(`@@ ${tail} unchanged line${tail === 1 ? '' : 's'} after`)
  return lines
}

function title(view: { title?: string }, fallback: string): string {
  const declared = view.title?.trim() ?? ''
  return declared === '' ? fallback : declared
}

/** Map a tool's pending-call intent to a card, falling back to the raw call name. */
export function cardOfCall(view: ToolCallView | undefined, fallbackName: string): ToolCard {
  if (view === undefined) {
    return { kind: 'generic', title: fallbackName, detail: [], failed: false, totalLines: 0 }
  }
  switch (view.card) {
    case 'terminal': {
      const terminal = view as TerminalCallView
      const lines = terminal.description === undefined || terminal.description === '' ? [] : [terminal.description]
      if (terminal.cwd !== undefined && terminal.cwd !== '') lines.push(`cwd ${terminal.cwd}`)
      return { kind: 'terminal', title: title(terminal, fallbackName), detail: bound(lines).detail, failed: false, totalLines: 0 }
    }
    case 'diff': {
      const diff = view as DiffCallView
      const lines = diff.diffs.flatMap(renderFileDiff)
      const bounded = bound(lines)
      return { kind: 'diff', title: title(diff, fallbackName), detail: bounded.detail, failed: false, totalLines: bounded.totalLines }
    }
    default: {
      const generic = view as GenericCallView
      const lines = contentLines(generic.content)
      if (generic.rawInput !== undefined && lines.length === 0) {
        lines.push(typeof generic.rawInput === 'string' ? generic.rawInput : JSON.stringify(generic.rawInput))
      }
      const bounded = bound(lines)
      return { kind: 'generic', title: title(generic, fallbackName), detail: bounded.detail, failed: false, totalLines: bounded.totalLines }
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
    const bounded = bound(input.contentLines)
    return { kind: 'generic', title: input.fallbackTitle, detail: bounded.detail, failed, totalLines: bounded.totalLines }
  }
  switch (view.card) {
    case 'terminal': {
      const terminal = view as TerminalResultView
      const lines = (terminal.output ?? '').split('\n')
      const status = terminal.signal !== undefined && terminal.signal !== ''
        ? `signal ${terminal.signal}`
        : terminal.exitCode === undefined ? undefined : `exit ${terminal.exitCode}`
      if (status !== undefined) lines.push(status)
      const bounded = bound(lines)
      return { kind: 'terminal', title: title(terminal, input.fallbackTitle), detail: bounded.detail, failed, totalLines: bounded.totalLines }
    }
    case 'diff': {
      const diff = view as DiffResultView
      const bounded = bound(diff.diffs.flatMap(renderFileDiff))
      return { kind: 'diff', title: title(diff, input.fallbackTitle), detail: bounded.detail, failed, totalLines: bounded.totalLines }
    }
    case 'search': {
      const search = view as SearchResultView
      const lines = search.shape === 'paths'
        ? [...search.paths]
        : search.files.flatMap(file => file.matches.map(match => `${file.path}:${match.lineNumber}: ${match.line}`))
      if (search.truncated) lines.push(`… ${search.total} total`)
      const bounded = bound(lines)
      return { kind: 'search', title: title(search, input.fallbackTitle), detail: bounded.detail, failed, totalLines: bounded.totalLines }
    }
    case 'read': {
      const read = view as ReadResultView
      const lines = read.lines.length > 0
        ? read.lines.map(line => `${line.number}: ${line.text}`)
        : contentLines(read.content)
      lines.unshift(`${read.path} (from line ${read.offset}, ${read.totalLines} total)`)
      const bounded = bound(lines)
      return { kind: 'read', title: title(read, input.fallbackTitle), detail: bounded.detail, failed, totalLines: bounded.totalLines }
    }
    case 'web': {
      const web = view as WebResultView
      const lines: string[] = []
      if (web.kind === 'search') {
        if (web.answer !== undefined && web.answer !== '') lines.push(...web.answer.split('\n'))
        for (const source of web.sources) lines.push(source.title === undefined ? source.url : `${source.title} — ${source.url}`)
        if (web.truncated) lines.push('… more sources')
      } else {
        lines.push(`${web.url} → ${web.statusCode}`)
        if (web.truncated) lines.push('… body truncated')
      }
      const bounded = bound(lines)
      return { kind: 'web', title: title(web, input.fallbackTitle), detail: bounded.detail, failed, totalLines: bounded.totalLines }
    }
    default: {
      const generic = view as GenericResultView
      const lines = contentLines(generic.content)
      const bounded = bound(lines.length > 0 ? lines : input.contentLines)
      return { kind: 'generic', title: title(generic, input.fallbackTitle), detail: bounded.detail, failed, totalLines: bounded.totalLines }
    }
  }
}
