/**
 * The air the surface keeps around what it shows.
 *
 * A token names a shade or a glyph, so how much room a message is given is not
 * something a theme can carry: it is layout the reader tunes once for their own
 * terminal, and the same read feeds the surface's own edges and every gap
 * between the things it draws.
 */

/** What one gap or edge may ask for, in rows or columns. */
export interface Spacing {
  /** Columns of air at the surface's left and right edges. */
  readonly padding: number
  /** Blank rows above and below a prompt or a reply card. */
  readonly messages: number
  /** Blank rows where a step of a turn opens, so a thought and the calls it made read as one group. */
  readonly steps: number
}

/**
 * The widest gap or edge the reader may ask for.
 *
 * Past a few rows the break stops reading as air between two things and starts
 * reading as a hole the reader has to scroll past on every message.
 */
export const MAX_SPACING = 3

/**
 * The shipped spacing: one column at the edges and one row at a break.
 *
 * Framed objects that touch the terminal's edge, or each other, read as one
 * wall of rows; a single column and a single row are what separate them
 * without spending the rows a message needs to be read in.
 */
export const DEFAULT_SPACING: Spacing = { padding: 1, messages: 1, steps: 1 }

/** The fields the `spacing:` block declares, so a misspelling is refused rather than ignored. */
const SPACING_FIELDS: ReadonlySet<string> = new Set(['padding', 'messages', 'steps'])

/** One count as the reader wrote it. */
function count(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_SPACING) {
    throw new Error('spacing.' + field + ' must be an integer between 0 and ' + MAX_SPACING)
  }
  return value
}

/**
 * The `spacing:` block as the reader wrote it.
 *
 * Absent fields keep the shipped value, so a reader who wants only the gaps
 * turned off writes one line rather than the whole block.
 */
export function parseSpacing(raw: unknown): Spacing {
  if (raw === undefined) return DEFAULT_SPACING
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('spacing must be a mapping of counts')
  const block = raw as Record<string, unknown>
  const stray = Object.keys(block).filter(field => !SPACING_FIELDS.has(field))
  if (stray.length > 0) throw new Error('unknown spacing field' + (stray.length === 1 ? '' : 's') + ': ' + stray.join(', '))
  return {
    padding: block.padding === undefined ? DEFAULT_SPACING.padding : count(block.padding, 'padding'),
    messages: block.messages === undefined ? DEFAULT_SPACING.messages : count(block.messages, 'messages'),
    steps: block.steps === undefined ? DEFAULT_SPACING.steps : count(block.steps, 'steps'),
  }
}
