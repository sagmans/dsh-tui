import { actionLabel, keyName, keysFor, matchesAction, type Keymap } from './input/actions.ts'

/** The outcome vocabulary the approval seam accepts from an answerer. */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled'

/** How a pending gate presents itself, independent of how it is drawn. */
export interface GateCard {
  readonly kind: 'approval' | 'question'
  readonly title: string
  readonly detail: readonly string[]
  /**
   * The number the first drawn option answers for. A list longer than the
   * screen shows a window of itself, and a window that restarts at one every
   * scroll hides where the reader is and contradicts the digits that pick by
   * that same number.
   */
  readonly optionOffset: number
  readonly options: readonly GateOption[]
  /**
   * The row that answers with typed text. A question with no options is answered
   * by typing anyway, so it has no such row to draw.
   */
  readonly custom: GateCustomRow | undefined
  /**
   * The editor the answer is written in, drawn under the row that fills it.
   *
   * A question says nothing about its answer until someone writes one, so the
   * rows come from the surface's own editor rather than from text composed
   * here: the reader gets the cursor movement, deletion, undo, and paste the
   * prompt bar already has.
   */
  readonly answerInput: GateInput | undefined
  readonly hint: string
}

/**
 * The editor a question collects typed text with.
 *
 * These are the editor's own members rather than a vocabulary invented here, so
 * the surface hands in the component the prompt bar already uses and nothing
 * has to adapt it. Every key the gate does not claim — movement, deletion,
 * undo, a pasted block — reaches the answer through this.
 */
export type GateInputMode = 'answer' | 'secret'

export interface GateInput {
  /** The answer as written, with a pasted block expanded back to its text. */
  getExpandedText(): string
  /** Replace the answer, so the next question of a batch does not inherit one. */
  setText(text: string): void
  /** Lay the answer out for this width; its rows are drawn under the free-text row. */
  render(width: number): string[]
  /** Take a key the gate itself did not claim. */
  handleInput(data: string): void
  /**
   * How the surface shows the answer it is collecting, absent on an editor
   * that has no way to hide one.
   */
  setMode?(mode: GateInputMode): void
}

/** One selectable row of a question gate. */
export interface GateOption {
  readonly label: string
  readonly description: string | undefined
  readonly current: boolean
  readonly selected: boolean
}

/** The row that answers with typed text instead of a listed label. */
export interface GateCustomRow {
  readonly label: string
  readonly description: string | undefined
  /** Whether the cursor is on this row, which is what makes typing the answer. */
  readonly current: boolean
  /** Whether a custom answer is being formed or already holds text. */
  readonly selected: boolean
}

export function lines(value: string): string[] {
  return value.split('\n').filter(line => line.trim() !== '')
}

/**
 * One pending approval.
 *
 * The gate is a pure state machine: it turns key presses into the one outcome
 * the seam accepts and never infers a durable grant, because a terminal key
 * press is a single decision about a single call.
 */
export class ApprovalGate {
  private outcome: ApprovalOutcome | undefined

  constructor(
    private readonly toolName: string,
    private readonly reason: string | undefined,
    /** The keys in force, read per press so a settings edit lands on the next key. */
    private readonly keys: () => Keymap,
  ) {}

  get resolved(): boolean {
    return this.outcome !== undefined
  }

  /** Apply one key press; returns the outcome the first time it settles. */
  handleKey(data: string): ApprovalOutcome | undefined {
    if (this.outcome !== undefined) return undefined
    if (matchesAction(this.keys(), 'gate.allow', data)) this.outcome = 'allowed-once'
    else if (matchesAction(this.keys(), 'gate.reject', data)) this.outcome = 'rejected'
    else if (matchesAction(this.keys(), 'gate.cancel', data)) this.outcome = 'cancelled'
    return this.outcome
  }

  cancel(): void {
    this.outcome ??= 'cancelled'
  }

  card(): GateCard {
    return {
      kind: 'approval',
      title: `approval needed · ${this.toolName}`,
      detail: this.reason === undefined ? [] : lines(this.reason),
      answerInput: undefined,
      optionOffset: 0,
      options: [],
      custom: undefined,
      hint: this.outcome === undefined
        ? ['gate.allow', 'gate.reject', 'gate.cancel']
          .map(id => keysFor(this.keys(), id).map(key => `${keyName(key)} ${actionLabel(id)}`).join(' · '))
          .join(' · ')
        : 'decided',
    }
  }
}

/** One question as the seam describes it. */
export interface GateQuestion {
  readonly id: string
  readonly question: string
  readonly header: string | undefined
  readonly detail: string | undefined
  readonly options: readonly { readonly label: string; readonly description: string | undefined }[]
  readonly multiSelect: boolean
}

/** One answered question in the batch result. */
export interface GateAnswer {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

/** The number the free-text row answers for. It sits below the window, so drawn numbering runs 1..n then 0. */
export const CUSTOM_ROW_NUMBER = 0
