import { type CardRow, cardRow, type CardStat, type ToolCard, bound, boundTail, contentLines } from '../cards.ts'
import { type DiffCallView, type DiffResultView, type FileDiff, type GenericCallView, type GenericResultView, type ReadResultView, type SearchResultView, type TerminalCallView, type TerminalResultView, type ToolCallView, type ToolResultView, type WebResultView } from '@deepseek-ai/dsh-tools'
import { countTokens, formatTokens } from '../tokens.ts'

/** A text with the newline that only terminates its last line removed. */
function withoutTrailingBreaks(text: string): string {
  return text.replace(/\n+$/, '')
}

/** How many lines a text holds, ignoring the newline that only terminates the last one. */
function lineCount(text: string): number {
  const body = withoutTrailingBreaks(text)
  return body === '' ? 0 : body.split('\n').length
}

/**
 * The size of a text a card presents, in lines and in tokens.
 *
 * A reader deciding whether to open a file cares about both: lines say how tall
 * it is, tokens say what it cost to put in the conversation.
 */
function sizeStats(text: string): readonly CardStat[] {
  const body = withoutTrailingBreaks(text)
  const lines = lineCount(body)
  const tokens = countTokens(body)
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
 * additions or deletions — otherwise every edit reads as twice its size. Each
 * file is netted on its own for the same reason: one file's additions must not
 * cancel another file's deletions, or a change to two files reads as a rewrite
 * of neither.
 */
function changeStats(diffs: readonly FileDiff[]): readonly CardStat[] {
  let added = 0
  let changed = 0
  let removed = 0
  for (const diff of diffs) {
    let fileAdded = 0
    let fileRemoved = 0
    for (const row of renderFileDiff(diff)) {
      const cls = row.parts[0]?.class
      if (cls === 'added') fileAdded += 1
      else if (cls === 'removed') fileRemoved += 1
    }
    const fileChanged = Math.min(fileAdded, fileRemoved)
    added += fileAdded - fileChanged
    changed += fileChanged
    removed += fileRemoved - fileChanged
  }
  const stats: CardStat[] = []
  if (added > 0) stats.push({ kind: 'added', text: String(added) })
  if (changed > 0) stats.push({ kind: 'changed', text: String(changed) })
  if (removed > 0) stats.push({ kind: 'removed', text: String(removed) })
  return stats
}

/**
 * The window a read returned: its line range, how many lines, and their token size.
 *
 * An empty window still names the offset it starts at, because the view keeps it
 * for exactly that case, and counts the model-facing content the card falls back
 * to drawing rather than reporting a size of zero.
 */
function readStats(read: ReadResultView): readonly CardStat[] {
  const text = read.lines.length > 0
    ? read.lines.map(line => line.text).join('\n')
    : contentLines(read.content).join('\n')
  const count = read.lines.length > 0 ? read.lines.length : lineCount(text)
  const start = read.offset
  const stats: CardStat[] = [
    { kind: 'size', text: count <= 1 ? `L${start}` : `L${start}–${start + count - 1}` },
    { kind: 'size', text: `${count} line${count === 1 ? '' : 's'}` },
  ]
  const tokens = countTokens(withoutTrailingBreaks(text))
  if (tokens > 0) stats.push({ kind: 'size', text: `${formatTokens(tokens)} tok` })
  return stats
}

/**
 * A diff's measured facts: a change with no prior content reports its size,
 * while one that carried prior content reports its line changes.
 *
 * `oldText === null` means the prior content was unavailable at call time — a
 * new file, or a whole-file overwrite — so no diff can be counted and the size
 * is the only honest fact; naming that a *creation* would misread every
 * overwrite as a new file.
 */
function diffStats(diffs: readonly FileDiff[]): readonly CardStat[] {
  const withoutPrior = diffs.length > 0 && diffs.every(diff => diff.oldText === null)
  return withoutPrior ? sizeStats(diffs.map(diff => diff.newText).join('\n')) : changeStats(diffs)
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

/**
 * Verbs a presenter may open its title with that only restate the call.
 *
 * The subject a reader scans for is what follows the verb, so the surface draws
 * the card from there: "skill project-skill" rather than "Load skill
 * project-skill". Only a declared title is normalized — a path or a command is
 * the call's own data, and shortening that would misreport what ran — and the
 * list stays literal because inferring a verb could cut a real title short.
 */
const REDUNDANT_TITLE_LEADS = ['Load '] as const

export function title(view: { title?: string }, fallback: string): string {
  const declared = view.title?.trim() ?? ''
  const lead = REDUNDANT_TITLE_LEADS.find(prefix => declared.startsWith(prefix))
  const shown = lead === undefined ? declared : declared.slice(lead.length).trim()
  return shown === '' ? fallback : shown
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
export function cardOfCall(view: ToolCallView | undefined, name: string): ToolCard {
  if (view === undefined) {
    return { kind: 'generic', tool: name, title: name, detail: [], failed: false, totalLines: 0 }
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
        tool: name,
        title: name,
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
        return { kind: 'diff', tool: name, title: title(diff, name), detail: bounded.detail, failed: false, totalLines: bounded.totalLines }
      }
      return {
        kind: 'diff',
        tool: name,
        title: name,
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
        return { kind: 'generic', tool: name, title: title(generic, name), detail: bounded.detail, failed: false, totalLines: bounded.totalLines }
      }
      return {
        kind: 'generic',
        tool: name,
        title: name,
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
  input: { readonly name: string; readonly failed: boolean; readonly contentLines: readonly string[] },
): ToolCard {
  const failed = input.failed
  if (view === undefined) {
    const bounded = bound(input.contentLines.map(line => cardRow('detail', line)))
    return { kind: 'generic', tool: input.name, title: input.name, detail: bounded.detail, failed, totalLines: bounded.totalLines }
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
      // A command that exited non-zero, or died on a signal, is a call that
      // failed, whatever the log's own flag said: the harness reports a shell's
      // exit code as its result rather than as an error, so that flag is silent
      // about how the command actually ended.
      const endedBadly = terminal.exitCode === undefined
        ? terminal.signal !== undefined && terminal.signal !== ''
        : terminal.exitCode !== 0
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
        tool: input.name,
        title: input.name,
        ...(command === '' ? {} : { argument: command }),
        ...(status === undefined ? {} : { status }),
        detail: bounded.detail,
        failed: failed || endedBadly,
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
          tool: input.name,
          title: title(diff, input.name),
          ...(stats.length === 0 ? {} : { stats }),
          detail: bounded.detail,
          failed,
          totalLines: bounded.totalLines,
        }
      }
      return {
        kind: 'diff',
        tool: input.name,
        title: input.name,
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
      return {
        kind: 'search',
        tool: input.name,
        title: title(search, input.name),
        detail: bounded.detail,
        failed,
        totalLines: bounded.totalLines,
      }
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
        tool: input.name,
        title: input.name,
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
      return {
        kind: 'web',
        tool: input.name,
        title: title(web, input.name),
        detail: bounded.detail,
        failed,
        totalLines: bounded.totalLines,
      }
    }
    default: {
      const generic = view as GenericResultView
      const lines = contentLines(generic.content)
      const chosen = lines.length > 0 ? lines : input.contentLines
      const bounded = bound(chosen.map(line => cardRow('detail', line)))
      return {
        kind: 'generic',
        tool: input.name,
        title: title(generic, input.name),
        detail: bounded.detail,
        failed,
        totalLines: bounded.totalLines,
      }
    }
  }
}
