import { fuzzyScore } from './fuzzy.ts'

/** One row the workspace offers: a file, or a directory to open. */
export interface Candidate {
  readonly path: string
  readonly isDirectory: boolean
}

/**
 * What the reader is typing after an at-sign.
 *
 * The prefix is the exact run a completion replaces; the query is what the
 * search reads, without the at-sign, the opening quote, or the dot-slash habit
 * a reader brings from a shell.
 */
export interface AtToken {
  readonly prefix: string
  readonly query: string
  readonly quoted: boolean
}

/** Suggestions a completion menu is allowed to gather at once. */
export const SUGGESTION_LIMIT = 20

/** Where one token ends and the next begins, as a shell reader expects. */
const TOKEN_DELIMITERS = new Set([' ', '\t', '"', "'", '='])

const QUOTE = '"'

const ESCAPE = '\\'

/**
 * Read the at-token the cursor sits in, or undefined when it sits in none.
 *
 * The reader may be mid-sentence, so only the last token counts. A closed
 * quote ends a token: once the path is quoted whole there is nothing left to
 * complete, and continuing to offer rows would replace text the reader already
 * spelled out.
 */
export function atToken(text: string): AtToken | undefined {
  // A quote still open swallows the spaces inside it, so it is read before any
  // delimiter scan: otherwise the space inside a quoted path would look like
  // the end of the token.
  const quoteStart = openQuoteStart(text)
  if (quoteStart !== null && quoteStart > 0 && text[quoteStart - 1] === '@' && isTokenStart(text, quoteStart - 1)) {
    const raw = unescape(text.slice(quoteStart + 1))
    return { prefix: text.slice(quoteStart - 1), query: withoutDotSlash(raw), quoted: true }
  }
  let start = 0
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (TOKEN_DELIMITERS.has(text[index] ?? '')) {
      start = index + 1
      break
    }
  }
  const token = text.slice(start)
  if (!token.startsWith('@')) return undefined
  return { prefix: token, query: withoutDotSlash(token.slice(1)), quoted: false }
}

/**
 * The text a pick inserts for a path.
 *
 * A quoted token is the only shape that can carry a space, a quote, or the
 * other characters that end a token, so a path holding one is quoted even when
 * the reader never typed a quote themselves; the reader of a token undoes it.
 * A directory that had to be quoted stays open, because a quote closed behind
 * the cursor would leave nowhere to keep typing the path below it.
 */
export function atValue(path: string, quoted: boolean, open: boolean): string {
  if (!quoted && !needsQuoting(path)) return '@' + path
  const escaped = path.replaceAll(ESCAPE, ESCAPE + ESCAPE).replaceAll(QUOTE, ESCAPE + QUOTE)
  return '@' + QUOTE + escaped + (open ? '' : QUOTE)
}

function needsQuoting(path: string): boolean {
  for (const character of path) {
    if (TOKEN_DELIMITERS.has(character)) return true
  }
  return false
}

/** Where the run's one still-open quote begins, or null when every quote closed. */
function openQuoteStart(text: string): number | null {
  let start: number | null = null
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    // An escaped quote is a path character, not the end of the run, so the
    // character after an escape is never read as a delimiter here.
    if (character === ESCAPE) {
      index += 1
      continue
    }
    if (character !== QUOTE) continue
    start = start === null ? index : null
  }
  return start
}

/** Read a quoted run back, so the fragment is the path and not its escapes. */
function unescape(raw: string): string {
  let out = ''
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index] ?? ''
    if (character === ESCAPE && index + 1 < raw.length) {
      const next = raw[index + 1] ?? ''
      if (next === ESCAPE || next === QUOTE) {
        out += next
        index += 1
        continue
      }
    }
    out += character
  }
  return out
}

/** Whether an at-sign at this index opens a token rather than continuing a word. */
function isTokenStart(text: string, index: number): boolean {
  return index === 0 || TOKEN_DELIMITERS.has(text[index - 1] ?? '')
}

/** Drop the dot-slash habit a shell reader brings, which no path in the index carries. */
function withoutDotSlash(raw: string): string {
  return raw.startsWith('./') ? raw.slice(2) : raw
}

/** Bytes a terminal executes rather than draws. */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/

/**
 * Whether a listed path may become a suggestion.
 *
 * A suggestion is inserted into the prompt the agent reads, so a path that
 * climbs out of the workspace, or that carries bytes a terminal would act on,
 * is never offered: the menu is the one place the reader cannot see the bytes
 * for what they are.
 */
export function offerablePath(path: string): boolean {
  return path !== '' && !path.startsWith('/') && !path.split('/').includes('..') && !CONTROL_CHARACTERS.test(path)
}

/** What a token cannot carry without being split, as the editor's own trigger reads it. */
const WHITESPACE_CHARACTER = /\s/

/**
 * Whether a row may be offered at all.
 *
 * A directory is a place to keep typing, and the editor only asks for
 * suggestions while the typed token holds no whitespace: offering a directory
 * whose path has one would leave the reader stuck after the pick. Its files
 * are still offered on their own, each with a value that needs no narrowing.
 */
export function offerableCandidate(candidate: Candidate): boolean {
  if (!offerablePath(candidate.path)) return false
  return !candidate.isDirectory || !WHITESPACE_CHARACTER.test(candidate.path)
}

/**
 * The rows that best answer the fragment, best first.
 *
 * Only the paths are searched, the way fzf searches a path list, so a fragment
 * may match a segment anywhere in the tree. Ties fall to a directory over a
 * file — a directory is a place to keep typing, a file ends the search — then
 * to the shallower, shorter path, which is the one the reader is likelier to
 * mean.
 */
export function rankFiles(query: string, candidates: readonly Candidate[], limit: number): readonly Candidate[] {
  const needle = query.trim()
  if (needle === '') return topLevel(candidates, limit)
  const scored: { candidate: Candidate; score: number }[] = []
  for (const candidate of candidates) {
    const score = fuzzyScore(needle, candidate.path)
    if (score === undefined) continue
    scored.push({ candidate, score })
  }
  scored.sort((left, right) => compareScored(left, right))
  return scored.slice(0, limit).map(entry => entry.candidate)
}

interface Scored {
  readonly candidate: Candidate
  readonly score: number
}

function compareScored(left: Scored, right: Scored): number {
  if (left.score !== right.score) return right.score - left.score
  if (left.candidate.isDirectory !== right.candidate.isDirectory) return left.candidate.isDirectory ? -1 : 1
  const depth = depthOf(left.candidate.path) - depthOf(right.candidate.path)
  if (depth !== 0) return depth
  const length = left.candidate.path.length - right.candidate.path.length
  if (length !== 0) return length
  return left.candidate.path.localeCompare(right.candidate.path)
}

export function depthOf(path: string): number {
  return path.split('/').length
}

/** The entries a bare at-sign offers: what sits directly in the workspace. */
function topLevel(candidates: readonly Candidate[], limit: number): readonly Candidate[] {
  return candidates
    .filter(candidate => !candidate.path.includes('/'))
    .sort((left, right) => {
      if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1
      return left.path.localeCompare(right.path)
    })
    .slice(0, limit)
}
