/**
 * What the surface's two control keys do when a press reaches the surface.
 *
 * The order is the whole design: one press peels one state, and the state
 * closest to what the reader is doing is the one it takes first. The decisions
 * live here rather than in the key handler so the precedence can be read, and
 * tested, without a terminal.
 */

/** What one cancel press asks the surface to take back, or that it asks for nothing. */
export type CancelStep = 'clear-editor' | 'reclaim-queued' | 'interrupt-turn' | 'leave-child-view' | 'hand-back'

/** The surface states a cancel press chooses between. */
export interface CancelState {
  /** Whether the prompt bar holds a draft, which is what the reader is writing. */
  readonly barHasText: boolean
  /** How many prompts the agent has not started, which an interrupt would drop. */
  readonly queuedPrompts: number
  /** Whether a turn is in flight on the session this surface drives. */
  readonly turnRunning: boolean
  /** Whether the transcript is showing a child's conversation. */
  readonly viewingChild: boolean
}

/**
 * The one state a cancel press takes back.
 *
 * The bar comes first because text is the reader's own work: a press while
 * something is typed is "start over", not "stop the agent". Queued prompts come
 * next, and they ask for more than a stop: an interrupt drops what the agent has
 * not started, so the press has to hand those words back rather than lose them.
 * The turn follows, because stopping work in flight is what the key is for. A
 * child's transcript is last: it is a place the reader went, not something that
 * is running, so it gives way to everything that is.
 */
export function cancelStep(state: CancelState): CancelStep {
  if (state.barHasText) return 'clear-editor'
  if (state.queuedPrompts > 0) return 'reclaim-queued'
  if (state.turnRunning) return 'interrupt-turn'
  if (state.viewingChild) return 'leave-child-view'
  return 'hand-back'
}

/** What one quit press asks the surface to do, or that it asks for nothing. */
export type QuitStep = 'quit' | 'cancel-then-quit' | 'hand-back'

/** The surface states a quit press chooses between. */
export interface QuitState {
  /** Whether the prompt bar holds text, which keeps the key for the editor. */
  readonly barHasText: boolean
  /** Whether the library has an overlay open, whose own field owns the keyboard. */
  readonly overlayOpen: boolean
  /** Whether a turn is in flight, which has to be cancelled on the way out. */
  readonly turnRunning: boolean
}

/**
 * What a quit press does.
 *
 * The bar keeps the key while it holds text, because the library's delete
 * forward is what the reader means there, and an open overlay keeps it because
 * the transcript search has a text field of its own. A running turn does not
 * block the exit: leaving is the reader's decision, so the turn is cancelled
 * rather than waited on.
 */
export function quitStep(state: QuitState): QuitStep {
  if (state.barHasText || state.overlayOpen) return 'hand-back'
  if (state.turnRunning) return 'cancel-then-quit'
  return 'quit'
}
