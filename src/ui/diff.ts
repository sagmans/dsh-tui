import type { TuiToken } from '../theme-tokens.ts'
import { splitGraphemes } from '../text.ts'

/**
 * The fence languages that name a unified diff.
 *
 * \`patch\` is git's own name for the format. Every other language keeps the
 * library's plain code path, because guessing from the +/- signs would recolour a
 * diff-shaped fragment of some other text as a change it is not.
 */
export const DIFF_FENCE_LANGUAGES = ['diff', 'patch'] as const

/**
 * How much text two paired rows must share before their difference is an edit.
 *
 * Below this the pair is a replacement that merely sits next to its old row, and
 * banding the middle of both would mark nearly the whole row as changed — the one
 * outcome that reads worse than no emphasis at all.
 */
export const DIFF_MIN_SHARED_GRAPHEMES = 4

/**
 * The longest pair this draws run by run.
 *
 * A streaming reply asks for the block again on every delta, and cutting a wall
 * of text into clusters twice per pair buys nothing a reader can see: past this
 * the pair draws whole-row, which is how a replacement looks anyway.
 */
export const DIFF_EMPHASIS_MAX_GRAPHEMES = 2048

/**
 * File-level scaffolding a unified diff carries around its hunks.
 *
 * Matched on the row's own prefix, so a content row — which always carries a
 * sign or the context space — can never reach this list.
 */
const DIFF_META_PREFIXES = [
  'diff --git ',
  'diff --cc ',
  'diff --combined ',
  'index ',
  'new file mode ',
  'deleted file mode ',
  'old mode ',
  'new mode ',
  'similarity index ',
  'dissimilarity index ',
  'rename from ',
  'rename to ',
  'copy from ',
  'copy to ',
  'Binary files ',
  'GIT binary patch',
  '\\ No newline at end of file',
] as const

/** What one row of a diff is, which is what decides how it is drawn. */
type DiffRowKind = 'header' | 'hunk' | 'context' | 'added' | 'removed'

/** The element each row class draws in. */
const ROW_TOKEN: Readonly<Record<DiffRowKind, TuiToken>> = {
  header: 'markdown.diff.header',
  hunk: 'markdown.diff.hunk',
  context: 'markdown.diff.context',
  added: 'markdown.diff.added',
  removed: 'markdown.diff.removed',
}

/** The band the changed characters of a paired row draw on; a row class with no partner has none. */
const EMPHASIS_TOKEN: Readonly<Partial<Record<DiffRowKind, TuiToken>>> = {
  added: 'markdown.diff.addedEmphasis',
  removed: 'markdown.diff.removedEmphasis',
}

/** One run of a row, and whether it is part of what changed. */
interface Run {
  readonly text: string
  readonly changed: boolean
}

/** How a fenced block draws where it names a language the surface does not draw itself. */
export interface FenceLook {
  readonly style: (token: TuiToken, text: string) => string
  readonly visible: (token: TuiToken) => boolean
  /** The shade a code row keeps when its language has no drawing of its own. */
  readonly plain: (line: string) => string
}

/** A look for a block this surface draws itself, where the plain path is never reached. */
export type DiffLook = Omit<FenceLook, 'plain'>

/** The first word of a fence's info string, lowercased: an info string may carry more than the language. */
function fenceLanguage(lang: string | undefined): string {
  return lang?.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? ''
}

/** Whether a fence names a unified diff. */
export function isDiffFence(lang: string | undefined): boolean {
  return (DIFF_FENCE_LANGUAGES as readonly string[]).includes(fenceLanguage(lang))
}

/**
 * The library's own code-block path: one row per source line in the fence's plain shade.
 *
 * Spelled here rather than left to the library because a theme that answers for
 * one language answers for every fence the library draws, and the rows of the
 * languages it does not draw have to come out exactly as they did before.
 */
export function plainCodeLines(code: string, plain: (line: string) => string): string[] {
  return code.split('\n').map(line => plain(line))
}

/** Every row of a fence: a diff drawn row by row, or the plain path for any other language. */
export function codeBlockLines(code: string, lang: string | undefined, look: FenceLook): string[] {
  return isDiffFence(lang) ? renderDiffBlock(code, look) : plainCodeLines(code, look.plain)
}

/**
 * What one row is, with the two rows that look alike told apart.
 *
 * A removed row whose content begins with "--" draws exactly like a file header,
 * so the header pair is recognised by its neighbour rather than by its prefix;
 * inside a hunk every row carries a sign, and there the pair rule is off.
 */
function rowKind(line: string, previous: string | undefined, next: string | undefined, inHunk: boolean): DiffRowKind {
  if (line.startsWith('@@')) return 'hunk'
  const pairedHeader = !inHunk
    && ((line.startsWith('--- ') && next?.startsWith('+++ ') === true)
      || (line.startsWith('+++ ') && previous?.startsWith('--- ') === true))
  if (pairedHeader || DIFF_META_PREFIXES.some(prefix => line.startsWith(prefix))) return 'header'
  if (line.startsWith('+')) return 'added'
  if (line.startsWith('-')) return 'removed'
  return 'context'
}

/** The longest shared head and matching tail of two rows, in clusters. */
function sharedEdges(before: readonly string[], after: readonly string[]): { readonly head: number; readonly tail: number } {
  let head = 0
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1
  let tail = 0
  while (
    tail < before.length - head
    && tail < after.length - head
    && before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) tail += 1
  return { head, tail }
}

/** One side of a paired edit as the runs it draws: what it kept, what it changed, what it kept. */
function runsFor(clusters: readonly string[], head: number, tail: number): readonly Run[] {
  const kept = clusters.slice(0, head).join('')
  const changed = clusters.slice(head, clusters.length - tail).join('')
  const rest = tail === 0 ? '' : clusters.slice(clusters.length - tail).join('')
  const runs: Run[] = []
  if (kept !== '') runs.push({ text: kept, changed: false })
  if (changed !== '') runs.push({ text: changed, changed: true })
  if (rest !== '') runs.push({ text: rest, changed: false })
  return runs
}

/**
 * Both sides of one paired edit, or nothing when the two are not an edit of one row.
 *
 * Anything proportional to the pair's length is measured in clusters, so a band
 * can never cut a character a reader sees as one — a combining mark or a joined
 * emoji would otherwise take the band on half of itself.
 */
function pairRuns(removed: string, added: string): { readonly removed: readonly Run[]; readonly added: readonly Run[] } | undefined {
  const before = splitGraphemes(removed)
  const after = splitGraphemes(added)
  if (before.length > DIFF_EMPHASIS_MAX_GRAPHEMES || after.length > DIFF_EMPHASIS_MAX_GRAPHEMES) return undefined
  const { head, tail } = sharedEdges(before, after)
  if (head + tail < DIFF_MIN_SHARED_GRAPHEMES) return undefined
  return { removed: runsFor(before, head, tail), added: runsFor(after, head, tail) }
}

/**
 * One row, with the sign in the row's own shade and the changed runs banded.
 *
 * A hidden emphasis draws the run in the row's colour instead of dropping it: an
 * element the reader removed must not punch an unstyled hole in a coloured row.
 */
function drawRow(line: string, kind: DiffRowKind, runs: readonly Run[] | undefined, look: DiffLook): string {
  const rowToken = ROW_TOKEN[kind]
  if (runs === undefined) return look.style(rowToken, line)
  const emphasis = EMPHASIS_TOKEN[kind]
  const banded = emphasis !== undefined && look.visible(emphasis) ? emphasis : rowToken
  const sign = look.style(rowToken, line.slice(0, 1))
  const content = runs.map(run => look.style(run.changed ? banded : rowToken, run.text)).join('')
  return `${sign}${content}`
}

/** Where each paired row's changed runs sit, keyed by the row they belong to. */
function emphasisByRow(lines: readonly string[], kinds: readonly DiffRowKind[]): ReadonlyMap<number, readonly Run[]> {
  const runs = new Map<number, readonly Run[]>()
  for (let at = 0; at < lines.length; at += 1) {
    if (kinds[at] !== 'removed') continue
    // The run of removed rows this one opens, and the added run that answers it:
    // a hunk may drop two rows and add one, and only the pairs are edits.
    let removedEnd = at
    while (kinds[removedEnd + 1] === 'removed') removedEnd += 1
    let addedEnd = removedEnd
    while (kinds[addedEnd + 1] === 'added') addedEnd += 1
    const pairs = Math.min(removedEnd - at + 1, addedEnd - removedEnd)
    for (let offset = 0; offset < pairs; offset += 1) {
      const before = (lines[at + offset] ?? '').slice(1)
      const after = (lines[removedEnd + 1 + offset] ?? '').slice(1)
      const paired = pairRuns(before, after)
      if (paired === undefined) continue
      runs.set(at + offset, paired.removed)
      runs.set(removedEnd + 1 + offset, paired.added)
    }
    at = addedEnd
  }
  return runs
}

/** One fenced diff, row by row, in the diff elements: headers and hunks recede and a changed run is banded. */
export function renderDiffBlock(code: string, look: DiffLook): string[] {
  const lines = code.split('\n')
  const kinds: DiffRowKind[] = []
  let inHunk = false
  for (let at = 0; at < lines.length; at += 1) {
    const kind = rowKind(lines[at] ?? '', lines[at - 1], lines[at + 1], inHunk)
    if (kind === 'hunk') inHunk = true
    kinds.push(kind)
  }
  const runs = emphasisByRow(lines, kinds)
  return lines.map((line, at) => drawRow(line, kinds[at] ?? 'context', runs.get(at), look))
}
