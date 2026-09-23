import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ForkEvent } from './fork.ts'

/**
 * The undo cursor's arithmetic, kept out of the terminal surface.
 *
 * The session log is append-only, so undo cannot delete a prompt: the cursor
 * only counts how many trailing turns the transcript hides and which prefix a
 * divergence continues from. Reading the turns from the log on every step keeps
 * the durable state a single number that can never go stale.
 */

/** One closed turn that contains a direct prompt and can be undone as a unit. */
export interface TurnPoint {
  /** Turn number the harness opened. */
  readonly turn: number
  /** Index of the turn's `turn/start`: the prefix a divergence inherits. */
  readonly seedCount: number
  /** The first direct prompt's text, which the composer gets back. */
  readonly promptText: string
}

/** The staged cursor over one session's closed turns. */
export interface UndoState {
  readonly sessionId: SessionId | undefined
  /** How many trailing turns the transcript hides; 0 is the tip. */
  readonly hidden: number
  /** The composer text this state wrote last, so a reader's edit is never overwritten. */
  readonly lastRestored: string
}

/** The cursor before any session is open. */
export const NO_UNDO: UndoState = { sessionId: undefined, hidden: 0, lastRestored: '' }

/**
 * How long an undo waits for an interrupted turn to close before giving up.
 *
 * The harness closes the turn as its abort settles, so a wait is needed; a
 * bounded one keeps a stuck tool from leaving the key press unanswered.
 */
export const UNDO_TURN_SETTLE_MS = 10_000

/** The cursor at the tip of one session. */
export function resetUndo(sessionId: SessionId): UndoState {
  return { sessionId, hidden: 0, lastRestored: '' }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/** The text blocks of a direct prompt, joined the way the composer hands them back. */
function promptText(data: unknown): string {
  const content = asRecord(data)?.content
  const parts: string[] = []
  for (const block of Array.isArray(content) ? content : []) {
    const text = asRecord(block)?.text
    if (typeof text === 'string') parts.push(text)
  }
  return parts.join('\n')
}

/** Whether an event is the human's own prompt rather than injected context. */
function isDirectPrompt(event: ForkEvent): boolean {
  return event.type === 'user/message' && asRecord(asRecord(event.data)?.source)?.kind === 'user'
}

/** Where each delivered prompt first entered the inbox, by message id. */
function deliveryIndex(events: readonly ForkEvent[]): ReadonlyMap<string, number> {
  const delivered = new Map<string, number>()
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event?.type !== 'agent/inbox/spliced') continue
    const inserted = asRecord(event.data)?.inserted
    for (const message of Array.isArray(inserted) ? inserted : []) {
      const id = asRecord(message)?.id
      if (typeof id === 'string' && !delivered.has(id)) delivered.set(id, index)
    }
  }
  return delivered
}

/**
 * The closed turns a direct prompt can be undone from, in log order.
 *
 * A turn is one `turn/start`...`turn/end` bracket; only a closed bracket with at least one direct prompt
 * is a unit. Injected context also arrives as `user/message`, which is why the source kind is checked.
 */
export function turnsOf(events: readonly ForkEvent[]): readonly TurnPoint[] {
  const delivered = deliveryIndex(events)
  const turns: TurnPoint[] = []
  let open: { turn: number; startIndex: number; seedCount: number; promptText?: string } | undefined
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event === undefined) continue
    if (event.type === 'turn/start') {
      const turn = asRecord(event.data)?.turn
      open = { turn: typeof turn === 'number' ? turn : turns.length + 1, startIndex: index, seedCount: index }
      continue
    }
    if (open === undefined) continue
    if (open.promptText === undefined && isDirectPrompt(event)) {
      open.promptText = promptText(event.data)
      const id = asRecord(event.data)?.id
      // A prompt enters the log as an inbox splice just before the turn it
      // opens; a seed that kept that splice would make the branch deliver the
      // very prompt the reader undid, so the cut is the splice, not the turn.
      const splice = typeof id === 'string' ? delivered.get(id) : undefined
      open.seedCount = Math.min(open.startIndex, splice ?? open.startIndex)
      continue
    }
    if (event.type === 'turn/end') {
      if (open.promptText !== undefined) {
        turns.push({ turn: open.turn, seedCount: open.seedCount, promptText: open.promptText })
      }
      open = undefined
    }
  }
  return turns
}

/** Step the cursor one turn back, or undefined when nothing is left to hide. */
export function undoStep(state: UndoState, turns: readonly TurnPoint[]): UndoState | undefined {
  if (state.hidden >= turns.length) return undefined
  const hidden = state.hidden + 1
  return { ...state, hidden, lastRestored: turns[turns.length - hidden]?.promptText ?? state.lastRestored }
}

/** Step the cursor one turn forward, or undefined when it is already at the tip. */
export function redoStep(state: UndoState, turns: readonly TurnPoint[]): UndoState | undefined {
  if (state.hidden === 0) return undefined
  const hidden = state.hidden - 1
  return { ...state, hidden, lastRestored: hidden === 0 ? '' : turns[turns.length - hidden]?.promptText ?? '' }
}

/** The oldest hidden turn: where a divergence forks, or undefined at the tip. */
export function hiddenTail(state: UndoState, turns: readonly TurnPoint[]): TurnPoint | undefined {
  return state.hidden === 0 ? undefined : turns[turns.length - state.hidden]
}
