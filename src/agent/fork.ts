/** One durable event, as much of it as a fork decision needs. */
export interface ForkEvent {
  readonly type: string
  readonly data?: unknown
  readonly seq?: number
  /** Re-folding a log must preserve the clock of its recorded work. */
  readonly time?: number
}

/** Where a fork may branch, and how much of the log the child inherits. */
export interface ForkPoint {
  /** Events the child inherits, counted from the start of the log. */
  readonly inheritedEvents: number
  /** Boundary label for the fork notice, not the inherited-prefix offset. */
  readonly boundarySeq: number
}

/**
 * Where a session may be branched.
 *
 * A turn is the unit a conversation can be cut at: an open turn, an open step,
 * or a tool call without its result would leave the child holding half an
 * exchange. The cut is therefore anchored to the last completed turn and
 * extended to the next `turn/start`, which keeps the trailing bookkeeping of
 * that turn — this is the same boundary the host's own fork uses.
 */
export function forkPoint(events: readonly ForkEvent[]): ForkPoint | undefined {
  let boundary = -1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'turn/end') {
      boundary = index
      break
    }
  }
  if (boundary < 0) return undefined
  let cut = boundary + 1
  while (cut < events.length && events[cut]?.type !== 'turn/start') cut += 1
  // The notice still needs a boundary label when seq is absent; only the array
  // cut determines inheritance, so this index does not stand in for a durable seq.
  return { inheritedEvents: cut, boundarySeq: events[boundary]?.seq ?? boundary }
}
