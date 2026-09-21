/**
 * How well a row answers a fragment, scored the way fzf scores it.
 *
 * A greedy scan can say whether a fragment's characters are all present, but
 * not which of two rows the reader meant. This is the alignment fuzzy finders
 * use, with the constants fzf calibrates in its own source: matching a
 * character is worth a fixed amount, starting a word is worth more, continuing
 * a run is worth more than the gap it avoids, and every skipped character
 * costs — a little inside a run, more when it opens a new gap. A reader typing
 * `edtr` or `srccomp` gets a ranking their fingers recognize.
 *
 * Classes are read from the original text, so a camel hump keeps its bonus
 * while the comparison itself stays case-insensitive.
 *
 * Where the match starts is deliberately unscored: a caller that ranks
 * different kinds of rows needs that concern in its own bands, and the bands
 * in {@link matchScore} keep an early hit above a late one.
 */

/**
 * Character classes the bonus matrix distinguishes.
 *
 * A delimiter is a character a path or field is built from — fzf treats
 * `/,:;|` as such — because the start of a segment is a boundary a reader
 * aims at even though no whitespace precedes it.
 */
const WHITE = 0
const NON_WORD = 1
const DELIMITER = 2
const LOWER = 3
const UPPER = 4
const LETTER = 5
const NUMBER = 6

/** What one aligned character is worth, and what a gap costs. */
const SCORE_MATCH = 16
const SCORE_GAP_START = -3
const SCORE_GAP_EXTENSION = -1

/** What starting a word is worth, before the boundary class is considered. */
const BONUS_BOUNDARY = SCORE_MATCH / 2
const BONUS_NON_WORD = SCORE_MATCH / 2
/** A camel hump or a digit beside a letter pays one gap step less than a word start. */
const BONUS_CAMEL_123 = BONUS_BOUNDARY + SCORE_GAP_EXTENSION
/** What continuing a run is worth, priced against the gap it avoids opening. */
const BONUS_CONSECUTIVE = -(SCORE_GAP_START + SCORE_GAP_EXTENSION)
/** The first character of a fragment carries its bonus twice, because it is what the reader aimed at. */
const BONUS_FIRST_CHAR_MULTIPLIER = 2
/** A word after whitespace or the start of the text is the strongest boundary there is. */
const BONUS_BOUNDARY_WHITE = BONUS_BOUNDARY + 2
/** A word after a delimiter is next, because no whitespace marks it. */
const BONUS_BOUNDARY_DELIMITER = BONUS_BOUNDARY + 1

/** The class a text begins in, so its first character can open a word. */
const INITIAL_CLASS = WHITE
const DELIMITER_CHARACTERS = '/,:;|'
const WHITE_CHARACTERS = ' \t\n\v\f\r\u0085\u00a0'

const LOWER_PATTERN = /[a-z]/
const UPPER_PATTERN = /[A-Z]/
const NUMBER_PATTERN = /[0-9]/

function classOf(character: string): number {
  if (character >= 'a' && character <= 'z') return LOWER
  if (character >= 'A' && character <= 'Z') return UPPER
  if (NUMBER_PATTERN.test(character)) return NUMBER
  if (WHITE_CHARACTERS.includes(character)) return WHITE
  if (DELIMITER_CHARACTERS.includes(character)) return DELIMITER
  return NON_WORD
}

/**
 * What a character earns given the class before it.
 *
 * The order mirrors fzf's: a word opening after white, a delimiter, or a
 * non-word takes that boundary's bonus; a hump inside a word takes the smaller
 * camel one; and matching the separator itself is still worth something,
 * because a reader who typed it meant it.
 */
function bonusFor(previous: number, current: number): number {
  if (current >= NON_WORD) {
    if (previous === WHITE) return BONUS_BOUNDARY_WHITE
    if (previous === DELIMITER) return BONUS_BOUNDARY_DELIMITER
    if (previous === NON_WORD) return BONUS_BOUNDARY
  }
  if ((previous === LOWER && current === UPPER) || (previous !== NUMBER && current === NUMBER)) {
    return BONUS_CAMEL_123
  }
  if (current === NON_WORD || current === DELIMITER) return BONUS_NON_WORD
  if (current === WHITE) return BONUS_BOUNDARY_WHITE
  return 0
}

/**
 * The best reading of `needle` inside `haystack`, or undefined when its
 * characters do not all appear in order.
 *
 * Both sides are read case-insensitively, and an empty fragment narrows
 * nothing.
 */
export function fuzzyScore(needle: string, haystack: string): number | undefined {
  const query = needle.trim().toLowerCase()
  if (query === '') return 0
  const queryLength = query.length
  const textLength = haystack.length
  if (queryLength > textLength) return undefined

  // Cheap rejection first: most candidates in a workspace do not contain the
  // fragment at all, and an alignment table for each would cost more than the
  // list of them is worth.
  const folded = haystack.toLowerCase()
  let scanned = 0
  for (const character of query) {
    const found = folded.indexOf(character, scanned)
    if (found < 0) return undefined
    scanned = found + 1
  }

  // The bonus each position would earn, read from the original text so a camel
  // hump still reads as one.
  const bonuses = new Float64Array(textLength)
  let previousClass = INITIAL_CLASS
  for (let at = 0; at < textLength; at += 1) {
    const currentClass = classOf(haystack[at] ?? '')
    bonuses[at] = bonusFor(previousClass, currentClass)
    previousClass = currentClass
  }

  // The earliest each character of the fragment can sit, so a row never reads
  // left of where its own character could first match.
  const earliest = new Int32Array(queryLength)
  let searched = 0
  for (let index = 0; index < queryLength; index += 1) {
    const found = folded.indexOf(query[index] ?? '', searched)
    if (found < 0) return undefined
    earliest[index] = found
    searched = found + 1
  }
  // The last place the fragment's final character appears: no alignment can
  // reach past it, so no row is scored there.
  const latest = folded.lastIndexOf(query[queryLength - 1] ?? '')

  // Row zero: the best score for the fragment's first character at each
  // position, clamped at zero the way a local alignment is.
  let previousRow = new Float64Array(textLength)
  let previousRuns = new Float64Array(textLength)
  let best = 0
  let running = 0
  let inGap = false
  for (let at = 0; at < textLength; at += 1) {
    if (folded[at] === query[0]) {
      running = SCORE_MATCH + (bonuses[at] ?? 0) * BONUS_FIRST_CHAR_MULTIPLIER
      previousRuns[at] = 1
      inGap = false
    } else {
      running = Math.max(running + (inGap ? SCORE_GAP_EXTENSION : SCORE_GAP_START), 0)
      inGap = true
    }
    previousRow[at] = running
    if (queryLength === 1 && running > best) best = running
  }

  for (let index = 1; index < queryLength; index += 1) {
    const row = new Float64Array(textLength)
    const runs = new Float64Array(textLength)
    const character = query[index] ?? ''
    let left = 0
    inGap = false
    const from = earliest[index] ?? 0
    for (let at = from; at <= latest; at += 1) {
      const skipped: number = left + (inGap ? SCORE_GAP_EXTENSION : SCORE_GAP_START)
      let matched = 0
      let consecutive = 0
      if (folded[at] === character) {
        matched = (previousRow[at - 1] ?? 0) + SCORE_MATCH
        const bonus = bonuses[at] ?? 0
        consecutive = (previousRuns[at - 1] ?? 0) + 1
        let credit = bonus
        if (consecutive > 1) {
          const chunkStart = bonuses[at - consecutive + 1] ?? 0
          // A fresh word start inside a run is a new chunk, not a longer one.
          if (bonus >= BONUS_BOUNDARY && bonus > chunkStart) {
            consecutive = 1
          } else {
            credit = Math.max(bonus, BONUS_CONSECUTIVE, chunkStart)
          }
        }
        if (matched + credit < skipped) {
          matched += bonus
          consecutive = 0
        } else {
          matched += credit
        }
      }
      runs[at] = consecutive
      inGap = matched < skipped
      const score = Math.max(matched, skipped, 0)
      row[at] = score
      left = score
      if (index === queryLength - 1 && score > best) best = score
    }
    previousRow = row
    previousRuns = runs
  }

  return best
}
