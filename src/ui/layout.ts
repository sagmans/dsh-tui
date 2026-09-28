import { HStack, VStack, type Component } from '@earendil-works/pi-tui'
import { Gutter } from './gutter.ts'

/**
 * The rows the input bar keeps when every other row is contested.
 *
 * The frame's two rules and one row of text: a bar that cannot show what the
 * reader is typing is not a bar, so this floor is reserved before any work
 * summary is allowed a row.
 */
export const PROMPT_MIN_ROWS = 3

/** The parts of the surface the root layout stacks, top to bottom. */
export interface SurfaceParts {
  /** The transcript viewport, which takes every row nothing else claims. */
  readonly transcript: Component
  /** The work board: goals, plans, running jobs, and running subagents. */
  readonly dock: Component
  /** The prompts waiting behind the running turn. */
  readonly queue: Component
  /** The prompt bar, borrowed when a question is answered in it. */
  readonly prompt: Component
  /** The footer. */
  readonly status: Component
}

/**
 * What one column of the surface's own margin costs, as the rows are drawn.
 *
 * A getter rather than a count: the margin is a preference, and a preference the
 * reader edits gets read again on the next frame instead of waiting for a restart.
 */
export type MarginColumns = () => number

/** The conversation and the work boards under it, which are what a margin insets. */
function insetColumn(parts: SurfaceParts): VStack {
  return new VStack([
    { component: parts.transcript, basis: 0, grow: 1, minSize: 1 },
    // Work state earns rows only when there is some, and it gives them up first:
    // a job ticker is worth less than the input the reader is typing into.
    { component: parts.dock, basis: 'auto', shrink: 2, minSize: 0 },
  ])
}

/**
 * The conversation's rows, held between the margin's two leaves.
 *
 * A pair of leaves beside the column rather than a wrapper round it, so the
 * transcript keeps the place in the layout it had without one — its scroll view
 * among them — and the reader's columns come off the width of the rows inside.
 */
function inset(parts: SurfaceParts, margin: MarginColumns): HStack {
  return new HStack([
    { component: new Gutter(margin), basis: 'auto', minSize: 0 },
    { component: insetColumn(parts), basis: 0, grow: 1, minSize: 1 },
    { component: new Gutter(margin), basis: 'auto', minSize: 0 },
  ])
}

/**
 * Stack the surface, deciding who gives up rows when the terminal is short.
 *
 * The transcript grows into whatever is left; the dock, the queue, and the bar
 * shrink in that order of eagerness, and the bar keeps a floor no shrink can
 * take. A dock that could not shrink held its whole height on a short terminal
 * and pushed the draft, its frame, and the footer out of the frame entirely,
 * because a clipped leaf cannot restore rows the allocator never gave it.
 *
 * The margin belongs to the conversation, so the rows the reader types in, the
 * prompts waiting behind them, and the footer keep the full width they have on
 * every other surface: a bar inset on both sides would read as one more card of
 * the transcript rather than as the thing the reader writes into.
 */
export function surfaceLayout(parts: SurfaceParts, margin: MarginColumns = () => 0): VStack {
  return new VStack([
    { component: inset(parts, margin), basis: 0, grow: 1, minSize: 1 },
    // Queued input earns rows only while something is waiting, and it gives
    // them up before the editor does: the bar being typed in outranks what is
    // waiting behind it.
    { component: parts.queue, basis: 'auto', shrink: 2, minSize: 0 },
    { component: new VStack([{ component: parts.prompt, basis: 'auto', shrink: 1, minSize: 1 }]), basis: 'auto', shrink: 1, minSize: PROMPT_MIN_ROWS },
    { component: parts.status, basis: 'auto', shrink: 0, minSize: 1 },
  ])
}
