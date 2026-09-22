import { VStack, type Component } from '@earendil-works/pi-tui'

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
 * Stack the surface, deciding who gives up rows when the terminal is short.
 *
 * The transcript grows into whatever is left; the dock, the queue, and the bar
 * shrink in that order of eagerness, and the bar keeps a floor no shrink can
 * take. A dock that could not shrink held its whole height on a short terminal
 * and pushed the draft, its frame, and the footer out of the frame entirely,
 * because a clipped leaf cannot restore rows the allocator never gave it.
 */
export function surfaceLayout(parts: SurfaceParts): VStack {
  return new VStack([
    { component: parts.transcript, basis: 0, grow: 1, minSize: 1 },
    // Work state earns rows only when there is some, and it gives them up first:
    // a job ticker is worth less than the input the reader is typing into.
    { component: parts.dock, basis: 'auto', shrink: 2, minSize: 0 },
    // Queued input earns rows only while something is waiting, and it gives
    // them up before the editor does: the bar being typed in outranks what is
    // waiting behind it.
    { component: parts.queue, basis: 'auto', shrink: 2, minSize: 0 },
    { component: new VStack([{ component: parts.prompt, basis: 'auto', shrink: 1, minSize: 1 }]), basis: 'auto', shrink: 1, minSize: PROMPT_MIN_ROWS },
    { component: parts.status, basis: 'auto', shrink: 0, minSize: 1 },
  ])
}
