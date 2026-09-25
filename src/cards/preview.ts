import { type CardRow, type ToolCard, CARD_DETAIL_MAX } from '../cards.ts'
import { title } from './presenter.ts'

/**
 * Output rows a folded card keeps on screen when a tool configures a tail.
 *
 * Shipped as the `tail` default for every tool, but drawn only when that tool
 * asks for `output: tail`: the shipped `output: hidden` is what makes a folded
 * card one line. The tail is the part that carries the outcome of a long run,
 * and the retention cap still bounds what ctrl+o can reveal.
 */
export const CARD_SHELL_PREVIEW = 20

/**
 * The tail of the hint a folded shell card draws when it dropped rows.
 *
 * "more" rather than "them": retention caps detail rows, so a command that
 * printed thousands of lines cannot promise ctrl+o will reveal every dropped
 * one.
 */
/** The fold hint names the key that opens the card, which the reader owns. */
const cardHintEarlier = (showMoreKey: string): string => `earlier lines · ${showMoreKey} shows more`

/**
 * The tail of the hint an opened shell card draws when retention dropped rows.
 *
 * Retention keeps the tail of a run, so the rows it refused are always the
 * beginning; a hint that only counted them would send the reader looking past
 * the end of the output for rows that are not there.
 */
const CARD_HINT_UNRETAINED_EARLIER = 'earlier lines not shown'

/**
 * How much of a card the reader has asked for.
 *
 * The folded state names its own treatment because the reader's settings decide
 * whether a folded card shows a tail of its rows or nothing beyond its header;
 * the count travels with the choice so the view never re-reads the policy.
 */
export type CardPreview =
  | { readonly expanded: true }
  | { readonly expanded: false; readonly preview: 'title' }
  | { readonly expanded: false; readonly preview: 'tail'; readonly rows: number }

/**
 * The rows a card shows right now, and how many the reader is not seeing.
 *
 * Expansion is a view decision rather than a card field so one key press can
 * change every card at once without rebuilding the transcript.
 */
export function cardDetailRows(card: ToolCard, preview: CardPreview): { lines: readonly CardRow[]; hidden: number } {
  const lines = preview.expanded
    ? card.detail.slice(0, CARD_DETAIL_MAX)
    : preview.preview === 'tail'
      ? card.detail.slice(Math.max(0, card.detail.length - Math.max(0, preview.rows)))
      : []
  return { lines, hidden: Math.max(0, card.totalLines - lines.length) }
}

/** The hint row for a folded shell card, or undefined when its preview dropped nothing. */
export function shellFoldHint(hidden: number, showMoreKey: string): string | undefined {
  return hidden <= 0 ? undefined : `… ${hidden} ${cardHintEarlier(showMoreKey)}`
}

/** The hint row for an opened shell card whose retention dropped the run's earlier rows. */
export function shellRetentionHint(hidden: number): string | undefined {
  return hidden <= 0 ? undefined : `… ${hidden} ${CARD_HINT_UNRETAINED_EARLIER}`
}
