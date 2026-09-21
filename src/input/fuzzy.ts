/**
 * How well a row answers a fragment, scored the way fzf scores it.
 *
 * A greedy scan can say whether a fragment's characters are all present, but
 * not which of two rows the reader meant. This is the alignment fuzzy finders
 * use, with the constants fzf calibrates in its own source: matching a
 * character is worth a fixed amount, starting a word is worth more, continuing
 * a run is worth more than the gap it avoids, and every skipped character
 * costs — a little inside a run, more when it opens a new gap. A reader typing
 * edtr or srccomp gets a ranking their fingers recognize.
 *
 * Classes are read from the original text, so a camel hump keeps its bonus
 * while the comparison itself stays case-insensitive. Matching works in code
 * points rather than UTF-16 units, and each one is folded on its own, so a
 * letter outside ASCII cannot change how many positions the text has.
 *
 * Where the match starts is deliberately unscored: a caller that ranks
 * different kinds of rows needs that concern in its own bands, and the bands
 * in {@link matchScore} keep an early hit above a late one.
 *
 * One deliberate divergence from fzf: for a one-character fragment fzf stops
 * at the first word boundary it meets, because its scan wants to stay cheap,
 * while this reads every position and keeps the best. A short fragment still
 * deserves the row that matches it best, and a test pins the difference.
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

/**
 * The categories fzf reads a code point outside ASCII by.
 *
 * Without them a letter such as é would be read as a word break, so a fragment
 * landing beside it would take a boundary bonus fzf never pays and outrank a
 * text fzf ranks higher.
 */
const UNICODE_SPACE_PATTERN = /\p{White_Space}/u
const UNICODE_LOWER_PATTERN = /\p{Ll}/u
const UNICODE_UPPER_PATTERN = /\p{Lu}/u
const UNICODE_NUMBER_PATTERN = /\p{N}/u
const UNICODE_LETTER_PATTERN = /\p{L}/u

function classOf(character: string): number {
  if (character >= 'a' && character <= 'z') return LOWER
  if (character >= 'A' && character <= 'Z') return UPPER
  if (NUMBER_PATTERN.test(character)) return NUMBER
  if (WHITE_CHARACTERS.includes(character)) return WHITE
  if (DELIMITER_CHARACTERS.includes(character)) return DELIMITER
  if (UNICODE_SPACE_PATTERN.test(character)) return WHITE
  if (UNICODE_LOWER_PATTERN.test(character)) return LOWER
  if (UNICODE_UPPER_PATTERN.test(character)) return UPPER
  if (UNICODE_NUMBER_PATTERN.test(character)) return NUMBER
  if (UNICODE_LETTER_PATTERN.test(character)) return LETTER
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
 * The lowercase of one code point, always exactly one code point back.
 *
 * JavaScript's whole-string lowercase can expand a character into two, or pick
 * a form that depends on its neighbours, and either one would move every index
 * after it in a table that has to line up with the original text.
 */
function simpleLower(code: number): number {
  if (code >= 0x41 && code <= 0x5a) return code + 0x20
  if (code < 0x80) return code
  return String.fromCodePoint(code).toLowerCase().codePointAt(0) ?? code
}

/** The comparison view of a text: one folded code point and one bonus per code point. */
interface PreparedText {
  readonly folded: Uint32Array
  readonly bonuses: Int32Array
}

function prepare(text: string): PreparedText {
  const characters = [...text]
  const folded = new Uint32Array(characters.length)
  const bonuses = new Int32Array(characters.length)
  let previousClass = INITIAL_CLASS
  for (let at = 0; at < characters.length; at += 1) {
    const character = characters[at] ?? ''
    const currentClass = classOf(character)
    folded[at] = simpleLower(character.codePointAt(0) ?? 0)
    bonuses[at] = bonusFor(previousClass, currentClass)
    previousClass = currentClass
  }
  return { folded, bonuses }
}

function foldQuery(needle: string): Uint32Array {
  const characters = [...needle]
  const folded = new Uint32Array(characters.length)
  for (let at = 0; at < characters.length; at += 1) {
    folded[at] = simpleLower((characters[at] ?? '').codePointAt(0) ?? 0)
  }
  return folded
}

/**
 * The case-folded text the scorer compares against.
 *
 * A caller that ranks in bands decides with the same view of a row the scorer
 * will use, so the fold is shared rather than spelled a second time: a second
 * case mapping could disagree on characters outside ASCII.
 */
export function foldSimple(text: string): string {
  let folded = ''
  for (const character of text) {
    folded += String.fromCodePoint(simpleLower(character.codePointAt(0) ?? 0))
  }
  return folded
}

/**
 * The best reading of `needle` inside `haystack`, or undefined when its
 * characters do not all appear in order.
 *
 * Both sides are read case-insensitively, and an empty fragment narrows
 * nothing.
 */
export function fuzzyScore(needle: string, haystack: string): number | undefined {
  const query = foldQuery(needle.trim())
  const queryLength = query.length
  if (queryLength === 0) return 0
  const text = prepare(haystack)
  const textLength = text.folded.length
  if (queryLength > textLength) return undefined

  // The earliest each character of the fragment can sit, so a row never reads
  // left of where its own character could first match. The scan is also the
  // cheap rejection: most candidates in a workspace do not contain the
  // fragment at all, and an alignment table for each would cost more than the
  // list of them is worth.
  const earliest = new Int32Array(queryLength)
  let searched = 0
  for (let index = 0; index < queryLength; index += 1) {
    const character = query[index] ?? 0
    let found = -1
    for (let at = searched; at < textLength; at += 1) {
      if (text.folded[at] === character) {
        found = at
        break
      }
    }
    if (found < 0) return undefined
    earliest[index] = found
    searched = found + 1
  }
  // The last place the fragment's final character appears: no alignment can
  // reach past it, so no row is scored there.
  const lastCharacter = query[queryLength - 1] ?? 0
  let latest = textLength - 1
  while (latest > 0 && text.folded[latest] !== lastCharacter) latest -= 1

  // Row zero: the best score for the fragment's first character at each
  // position, clamped at zero the way a local alignment is.
  const previousRow = new Int32Array(textLength)
  const previousRuns = new Int32Array(textLength)
  let best = 0
  let running = 0
  let inGap = false
  const firstCharacter = query[0] ?? 0
  for (let at = 0; at < textLength; at += 1) {
    if (text.folded[at] === firstCharacter) {
      running = SCORE_MATCH + (text.bonuses[at] ?? 0) * BONUS_FIRST_CHAR_MULTIPLIER
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
    const row = new Int32Array(textLength)
    const runs = new Int32Array(textLength)
    const character = query[index] ?? 0
    let left = 0
    inGap = false
    const from = earliest[index] ?? 0
    for (let at = from; at <= latest; at += 1) {
      const skipped: number = left + (inGap ? SCORE_GAP_EXTENSION : SCORE_GAP_START)
      let matched = 0
      let consecutive = 0
      if (text.folded[at] === character) {
        matched = (previousRow[at - 1] ?? 0) + SCORE_MATCH
        const bonus = text.bonuses[at] ?? 0
        consecutive = (previousRuns[at - 1] ?? 0) + 1
        let credit = bonus
        if (consecutive > 1) {
          const chunkStart = text.bonuses[at - consecutive + 1] ?? 0
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
    // The rows are rebuilt for each character of the fragment, so the arrays
    // that hold the previous one are replaced rather than copied.
    previousRow.set(row)
    previousRuns.set(runs)
  }

  return best
}
