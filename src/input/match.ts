/**
 * Where each kind of hit starts.
 *
 * A reader comparing rows expects an exact name to stay above a name that
 * merely contains what they typed, so one band always outranks the next.
 */
const EXACT_HIT = 4_000
const PREFIX_HIT = 3_000
const CONTIGUOUS_HIT = 2_000
const SCATTERED_HIT = 1_000

/** Most a hit's position can cost, so a worse kind never overtakes a better one. */
const POSITION_PENALTY_CAP = 500

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
 * A reader types fragments — `glm53` for `GLM-5.3`, `gptcdx` for a provider
 * name — so matching only a contiguous run makes them remember punctuation the
 * list already renders for them. Higher is a better match; `undefined` is the
 * only answer that means no match at all.
 */
export function matchScore(needle: string, haystack: string): number | undefined {
  const query = needle.trim().toLowerCase()
  if (query === '') return EXACT_HIT
  const text = haystack.toLowerCase()
  if (text === query) return EXACT_HIT
  if (text.startsWith(query)) return PREFIX_HIT
  const at = text.indexOf(query)
  if (at >= 0) return CONTIGUOUS_HIT - Math.min(at, POSITION_PENALTY_CAP)
  if (query.length < SCATTERED_MIN_LENGTH) return undefined
  return scatteredScore(query, text)
}

/**
 * The tightest scattered reading of a fragment, or undefined when its
 * characters are not all there in order.
 *
 * Every occurrence of the first character is tried, because the tightest
 * reading can start past an earlier one — the `g` inside a provider id is not
 * the `g` in the model name. How far into the row the fragment starts is the
 * contiguous bands' concern; counting it here would rank a spread-out hit that
 * happens to start early above a tighter one, which is the opposite of what
 * the reader typed.
 */
function scatteredScore(query: string, text: string): number | undefined {
  const head = query[0]
  if (head === undefined) return SCATTERED_HIT
  const rest = query.slice(1)
  let bestPenalty: number | undefined
  for (let start = text.indexOf(head); start >= 0; start = text.indexOf(head, start + 1)) {
    let from = start + 1
    let skipped = 0
    let complete = true
    for (const character of rest) {
      const found = text.indexOf(character, from)
      if (found < 0) {
        complete = false
        break
      }
      skipped += found - from
      from = found + 1
      if (bestPenalty !== undefined && skipped >= bestPenalty) {
        complete = false
        break
      }
    }
    if (complete && (bestPenalty === undefined || skipped < bestPenalty)) bestPenalty = skipped
  }
  return bestPenalty === undefined ? undefined : SCATTERED_HIT - Math.min(bestPenalty, POSITION_PENALTY_CAP)
}
