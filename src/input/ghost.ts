/**
 * Ghost completion over recorded prompts.
 *
 * Kept free of any terminal or storage handle: the rule that decides what to
 * offer is small but easy to get wrong at the edges (multiline prompts, a cursor
 * parked mid-text), so it is a pure function the editor calls per paint and a
 * test can drive without a screen.
 */

/** One recorded prompt, as this rule needs it. */
export interface GhostCandidate {
  readonly text: string
}

/** Where the editor's cursor sits, in the coordinates the base editor reports. */
export interface EditorCursor {
  readonly line: number
  readonly col: number
}

/** What one paint knows when it asks for a suggestion. */
export interface GhostInput {
  readonly entries: readonly GhostCandidate[]
  readonly text: string
  readonly lines: readonly string[]
  readonly cursor: EditorCursor
}

/** Marks a folded ghost so the reader knows the suggestion continues. */
export const NEWLINE_MARKER = '\u21b5'

/**
 * Leading whitespace travels with the word so a partial accept keeps spacing.
 *
 * A newline is whitespace too: a multiline suggestion starts its second word
 * with one, and refusing to take it would stall acceptance at the fold.
 */
const NEXT_WORD = /^\s*\S+/u

// Locale-independent grapheme clusters: a ghost is drawn inside a styled line,
// and slicing by code unit would orphan the high surrogate of an emoji or split
// a ZWJ cluster across the cursor cell.
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Whether the cursor sits past the last character of the whole text. */
export function isCursorAtTextEnd(input: { lines: readonly string[]; cursor: EditorCursor }): boolean {
  const lastLineIndex = Math.max(0, input.lines.length - 1)
  const lastLine = input.lines[lastLineIndex] ?? ''
  return input.cursor.line === lastLineIndex && input.cursor.col === lastLine.length
}

/**
 * The dimmed suffix to draw, or undefined when there is nothing to offer.
 *
 * Only the newest entry that starts with what is typed is offered, and an entry
 * identical to the typed text is skipped: otherwise the newest entry would draw
 * an empty ghost and hide the useful one behind it.
 */
export function ghostSuffix(input: GhostInput): string | undefined {
  if (input.text.length === 0) return undefined
  if (!isCursorAtTextEnd(input)) return undefined
  const match = input.entries.find(entry => entry.text !== input.text && entry.text.startsWith(input.text))
  return match === undefined ? undefined : match.text.slice(input.text.length)
}

/** The next word of a suffix, whitespace included, or undefined when there is none. */
export function nextGhostWord(text: string): string | undefined {
  return text.match(NEXT_WORD)?.[0]
}

/** The suffix as one drawn line: only the first line, marked when it continues. */
export function ghostDisplayLine(text: string): string {
  const newlineIndex = text.indexOf('\n')
  if (newlineIndex < 0) return text
  return text.slice(0, newlineIndex) + NEWLINE_MARKER
}

/** One grapheme per entry, so styling never lands inside a character. */
export function ghostGraphemes(text: string): string[] {
  return [...GRAPHEMES.segment(text)].map(segment => segment.segment)
}
