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
  /** Keep editing state beside its question so the renderer can place it beneath the active answer row. */
  readonly answerInput: GateInput | undefined
  readonly hint: string
}

/** Distinguish credential display requests so editors can mask text without changing submitted answers. */
type GateInputMode = 'answer' | 'secret'

/**
 * Use the surface's editor so answers retain prompt-bar editing behavior.
 * Keys the gate does not claim reach this editor without a separate adapter.
 */
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
   * Let the surface editor mask declared credentials without changing their text.
   * Masking is an editor display capability, not a prerequisite for collecting answers.
   * Editors without this hook still accept answers; this interface does not guarantee masking.
   */
  setMode?(mode: GateInputMode): void
}

/** Keep navigation separate from chosen labels so moving the cursor does not change a multi-select answer. */
interface GateOption {
  readonly label: string
  readonly description: string | undefined
  readonly current: boolean
  readonly selected: boolean
}

/** Keep cursor focus separate from retained custom text so leaving this row does not imply the answer is empty. */
interface GateCustomRow {
  readonly label: string
  readonly description: string | undefined
  /** Whether the cursor is on this row, which is what makes typing the answer. */
  readonly current: boolean
  /** Whether a custom answer is being formed or already holds text. */
  readonly selected: boolean
}

/** Keep gate detail compact so empty source lines do not spend screen rows above the choices. */
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

/** Normalize seam requests into gate-owned questions while retaining ids that associate batch answers with their requests. */
export interface GateQuestion {
  readonly id: string
  readonly question: string
  readonly header: string | undefined
  readonly detail: string | undefined
  readonly options: readonly { readonly label: string; readonly description: string | undefined }[]
  readonly multiSelect: boolean
}

/** Return each decision under its request id so the seam can associate selections and custom text with the right question. */
export interface GateAnswer {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

/** Reserve a shortcut outside the one-based option numbers so free text keeps the same key as the option list changes. */
export const CUSTOM_ROW_NUMBER = 0
