import { fuzzyScore } from './fuzzy.ts'

/**
 * Where each kind of hit starts.
 *
 * A reader comparing rows expects an exact name to stay above a name that
 * merely contains what they typed, so one band always outranks the next. The
 * gaps between bands are wide enough that every fuzzy reading of a band stays
 * inside it.
 */
const EXACT_HIT = 4_000_000
const PREFIX_HIT = 3_000_000
const CONTIGUOUS_HIT = 2_000_000
const SCATTERED_HIT = 1_000_000

/**
 * What one character of distance from the start of the row costs.
 *
 * A contiguous hit that starts earlier is the class the reader is aiming at,
 * so its position has to outrank any difference the fuzzy reading can make
 * inside the same band; the fuzzy score is clamped below this step for that
 * reason.
 */
const POSITION_PENALTY_PER_CHAR = 1_000
const POSITION_PENALTY_CAP = 500

/** Room a fuzzy reading has inside its band, one point less than a band step. */
const FUZZY_BAND_CAP = POSITION_PENALTY_PER_CHAR - 1

/**
 * Shortest fragment allowed to gather scattered characters.
 *
 * One or two characters are a live search, and gathering them would match
 * almost every row and bury the one the reader means.
 */
const SCATTERED_MIN_LENGTH = 3

/**
 * How well a row answers what the reader typed.
 *
 * A reader types fragments — `glm53` for `GLM-5.3`, `edtr` for a path — so
 * matching only a contiguous run makes them remember punctuation the list
 * already renders for them. The band a hit lands in answers "what kind of hit
 * is this": an exact row, a row that opens with the fragment, one that holds
 * it whole, or one that only carries its characters in order. Inside a band
 * the fuzzy reading decides, which is what keeps a match on a word boundary
 * above the same letters spread through the middle of a word.
 *
 * Higher is a better match; `undefined` is the only answer that means no
 * match at all.
 */
export function matchScore(needle: string, haystack: string): number | undefined {
  const query = needle.trim().toLowerCase()
  if (query === '') return EXACT_HIT
  const text = haystack.toLowerCase()
  if (text === query) return EXACT_HIT
  if (text.startsWith(query)) return PREFIX_HIT + fuzzyWithin(query, text)
  const at = text.indexOf(query)
  if (at >= 0) {
    return CONTIGUOUS_HIT - Math.min(at, POSITION_PENALTY_CAP) * POSITION_PENALTY_PER_CHAR + fuzzyWithin(query, text)
  }
  if (query.length < SCATTERED_MIN_LENGTH) return undefined
  if (fuzzyScore(query, text) === undefined) return undefined
  return SCATTERED_HIT + fuzzyWithin(query, text)
}

/**
 * The fuzzy reading of a hit, held inside the band that hit already earned.
 *
 * A row that reaches one band must never overtake a row in the band above it,
 * however good its letters look.
 */
function fuzzyWithin(query: string, text: string): number {
  const raw = fuzzyScore(query, text)
  if (raw === undefined) return 0
  return Math.max(-FUZZY_BAND_CAP, Math.min(FUZZY_BAND_CAP, raw))
}
