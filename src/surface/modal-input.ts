import type { ProcessTerminal } from '@earendil-works/pi-tui'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import { ApprovalGate, type GateAnswer, type GateCard } from '../gates.ts'
import { QuestionGate, toGateQuestions } from '../gates/questions.ts'
import type { HerdrReporter } from '../herdr/reporter.ts'
import type { Keymap } from '../input/actions.ts'
import type { TuiTheme } from '../theme.ts'
import type { WarningSafeTui } from '../terminal/warning-screen.ts'
import type { GateInputBar } from '../ui/gate-input.ts'
import type { PickerAction, PickerCard } from '../ui/picker.ts'
import { PickerPopup, POPUP_MAX_HEIGHT, popupWidth } from '../ui/picker-card.ts'
import type { PromptBar } from '../ui/prompt.ts'

/** The one gate a terminal can present at a time, and how it settles its caller. */
type PendingGate =
  | { readonly kind: 'approval'; readonly gate: ApprovalGate; readonly settle: (outcome: ApprovalOutcome) => void }
  | { readonly kind: 'question'; readonly gate: QuestionGate; readonly settle: (answers: GateAnswer[]) => void }

/** What the surface needs of a list to drive it, wherever that list is drawn. */
export interface Picker {
  handleKey(data: string): PickerAction | undefined
  /** The row window the caller can afford, or the shipped window when it names none. */
  card(window?: number): PickerCard
  setNote(text: string | undefined): void
}

/** The one picker a terminal can present at a time, and how it settles its caller. */
interface PendingPicker {
  readonly picker: Picker
  readonly settle: (id: string | undefined) => void
  /**
   * Why this run cannot open an id, or undefined when it can.
   *
   * Asked before a pick settles, so a refusal the reader can act on stays in
   * the menu they are already looking at instead of ending the run.
   */
  readonly vet: ((id: string) => Promise<string | undefined>) | undefined
  /**
   * The card as the transcript draws it, or undefined when this list is drawn
   * over the transcript instead.
   *
   * A popup keeps its rows to itself: the work the reader paused stays the
   * context for what they are choosing, and repeating the list under the box
   * would only push that work off the screen.
   */
  readonly card: (() => PickerCard) | undefined
  /** Give back whatever this list was given: the screen a popup was shown on. */
  readonly release: (() => void) | undefined
}

/**
 * What the modal owner needs from the surface that composes it.
 *
 * Every one of these is a live read or an operation on another owner: the
 * keyboard and the screen are the only things this module takes for itself.
 */
export interface ModalInputPorts {
  readonly herdr: HerdrReporter
  readonly editor: GateInputBar
  readonly tui: WarningSafeTui
  readonly terminal: ProcessTerminal
  readonly theme: TuiTheme
  readonly keymap: () => Keymap
  readonly promptBar: PromptBar
  /** Rebuild the prompt's own menu once a borrowed bar is given back. */
  readonly refreshCompletion: () => void
  readonly activeSession: () => SessionId
}

/** The reads, operations and request listeners the composing surface routes here. */
export interface ModalInput {
  /** The card a pending gate draws, or undefined when no gate is open. */
  readonly gateCard: () => GateCard | undefined
  /** The card a pending picker draws in the transcript, when it draws one there. */
  readonly pickerCard: () => PickerCard | undefined
  readonly openPicker: (
    picker: Picker,
    vet?: (id: string) => Promise<string | undefined>,
    placement?: 'inline' | 'popup',
  ) => Promise<string | undefined>
  /** Drive an open gate or picker with one press; false hands the press back. */
  readonly handleKey: (data: string) => boolean
  /** The gate and question waterfalls, in the order the surface answers them. */
  readonly requestListeners: () => readonly (() => void)[]
}

/**
 * The one modal interaction a terminal can be in: a gate or a picker.
 *
 * Both take the keyboard and give it back the same way, and both can be
 * cancelled by something other than a press (an aborted request, a settled
 * list), so the focus, submission flag, blocked Herdr row and popup lifetime
 * belong to one owner rather than to every feature that opens a list.
 */
export function createModalInput(ctx: Context, ports: ModalInputPorts): ModalInput {
  let pending: PendingGate | undefined
  let pendingPicker: PendingPicker | undefined
  /** A pick being vetted owns the list, not the keyboard: filtering stays live while its verdict is read. */
  let vetting = false

  const openGate = (next: PendingGate): void => {
    pending = next
    // The card's own title names the decision, which is what a reader glancing
    // at a wall of panes needs in order to know which one to open.
    ports.herdr.block(next.gate.card().title)
    // A gate owns the keyboard: the editor must not collect the decision keys.
    ports.editor.disableSubmit = true
    ports.tui.setFocus(null)
    // A question is answered in this editor, which the gate draws under the row
    // being answered, so the hardware cursor belongs to it while it is borrowed.
    // It is set after the focus is cleared, which unmarks the component it left.
    ports.editor.focused = next.kind === 'question'
    ports.tui.requestRender()
  }

  const closeGate = (): void => {
    pending = undefined
    ports.herdr.unblock()
    ports.editor.disableSubmit = false
    // The question is answered or skipped, so the reader gets their prompt back
    // in the bar they left it in, with the menu the prompt bar offered.
    ports.promptBar.giveBack()
    ports.refreshCompletion()
    ports.tui.setFocus(ports.editor)
    ports.tui.requestRender()
  }

  /** Give the keyboard back to the editor and answer whoever opened the picker. */
  const settlePicker = (id: string | undefined): void => {
    const settle = pendingPicker?.settle
    // The screen goes back before the keyboard does: a box left behind a settled
    // list would sit over the transcript until something else repainted.
    pendingPicker?.release?.()
    pendingPicker = undefined
    ports.herdr.unblock()
    ports.editor.disableSubmit = false
    ports.tui.setFocus(ports.editor)
    settle?.(id)
    ports.tui.requestRender()
  }

  /**
   * Take the keyboard for a picker and answer with the id it settled on.
   *
   * Where the list is drawn is the caller's decision, because it is a decision
   * about the reader's attention. A list that is the destination — a session to
   * open, a model to switch to — joins the transcript and is read with it. A
   * list that is a reference for the work in front of the reader is drawn over
   * that work instead, so looking something up does not cost them their place.
   * The keyboard is owned the same way either way.
   */
  const openPicker = (
    picker: Picker,
    vet?: (id: string) => Promise<string | undefined>,
    placement: 'inline' | 'popup' = 'inline',
  ): Promise<string | undefined> =>
    new Promise<string | undefined>(resolve => {
      const overlay = placement === 'popup'
        ? ports.tui.showOverlay(
            new PickerPopup(rows => picker.card(rows), () => ports.terminal.rows, ports.theme),
            {
              width: popupWidth(ports.terminal.columns),
              maxHeight: POPUP_MAX_HEIGHT,
              anchor: 'center',
              margin: 1,
              // The surface's own listener reads every press before a focused
              // component does, so the box needs no focus to be driven; taking it
              // would only move focus away from where the reader left it.
              nonCapturing: true,
            },
          )
        : undefined
      pendingPicker = {
        picker,
        settle: resolve,
        vet,
        card: overlay === undefined ? () => picker.card() : undefined,
        release: overlay === undefined ? undefined : () => overlay.hide(),
      }
      // A picker owns the keyboard exactly as a gate does: nothing moves until
      // the reader chooses, so it is the same kind of wait.
      ports.herdr.block(picker.card().title)
      ports.editor.disableSubmit = true
      ports.tui.setFocus(null)
      ports.tui.requestRender()
    })

  /**
   * Read one press while a modal interaction owns the keyboard.
   *
   * The gate and picker branches keep their original priority: a key arrives as
   * a press and a release once the terminal reports key events, and the caller
   * drops the release for the focused component, so this only ever sees the
   * press the surface is meant to act on.
   */
  const handleKey = (data: string): boolean => {
    if (pending !== undefined) {
      if (pending.kind === 'approval') {
        const outcome = pending.gate.handleKey(data)
        if (outcome === undefined) ports.tui.requestRender()
        else {
          pending.settle(outcome)
          closeGate()
        }
      } else {
        const answers = pending.gate.handleKey(data)
        if (answers === undefined) ports.tui.requestRender()
        else {
          pending.settle(answers)
          closeGate()
        }
      }
      return true
    }
    if (pendingPicker !== undefined) {
      const action = pendingPicker.picker.handleKey(data)
      if (action === undefined) {
        ports.tui.requestRender()
        return true
      }
      if (vetting) {
        // A refusal check must not take the keyboard with it: the reader keeps
        // filtering and can still leave, while a second pick waits for the
        // first verdict rather than racing it.
        if (action.kind === 'cancel') settlePicker(undefined)
        return true
      }
      if (action.kind === 'cancel') {
        settlePicker(undefined)
        return true
      }
      const vet = pendingPicker.vet
      if (vet === undefined) {
        settlePicker(action.id)
        return true
      }
      vetting = true
      void (async () => {
        let reason: string | undefined
        try {
          reason = await vet(action.id)
        } finally {
          // A check that fails must not take the keyboard with it.
          vetting = false
        }
        if (pendingPicker === undefined) return
        if (reason === undefined) {
          settlePicker(action.id)
          return
        }
        pendingPicker.picker.setNote(reason)
        ports.tui.requestRender()
      })()
      return true
    }
    return false
  }

  return {
    gateCard: () => pending?.gate.card(),
    pickerCard: () => pendingPicker?.card?.(),
    openPicker,
    handleKey,
    requestListeners: () => [
      // Answering these two waterfalls is what makes a terminal surface usable at
      // all: without an answerer every gated tool fails closed, and the model's
      // questions never reach the human.
      ctx.on('approval/request', (request, next) => {
        if (request.agent.id !== ports.activeSession()) return next()
        return new Promise<ApprovalOutcome>(resolve => {
          const gate = new ApprovalGate(request.toolName, request.reason, ports.keymap)
          request.signal?.addEventListener('abort', () => {
            gate.cancel()
            if (pending?.gate === gate) closeGate()
            resolve('cancelled')
          }, { once: true })
          openGate({ kind: 'approval', gate, settle: resolve })
        })
      }),
      ctx.on('user-questions/request', (request, next) => {
        const agentId = (request as { agent?: { id?: string } }).agent?.id
        if (agentId !== undefined && agentId !== ports.activeSession()) return next()
        const questions = toGateQuestions(request)
        if (questions.length === 0) return next()
        return new Promise<AskUserQuestionAnswer>(resolve => {
          const gate = ports.promptBar.borrow(() => {
            // The bar is an answer's for as long as the gate holds it, so the menu
            // it once offered commands through is replaced before a key can reach it.
            const built = new QuestionGate(questions, ports.editor, ports.keymap)
            ports.refreshCompletion()
            return built
          })
          // The seam takes mutable selection arrays and an optional custom field, so
          // the read-only gate answer is copied into that exact shape here.
          const settle = (answers: GateAnswer[]): void => {
            request.signal?.removeEventListener('abort', onAbort)
            resolve({
              answers: answers.map(answer => ({
                id: answer.id,
                selected: [...answer.selected],
                ...(answer.custom === undefined ? {} : { custom: answer.custom }),
              })),
            })
          }
          // A question whose caller is gone has no reader, so the gate must release
          // the keyboard instead of collecting an answer the aborted call discards.
          const onAbort = (): void => {
            gate.cancel()
            if (pending?.gate === gate) closeGate()
            settle([])
          }
          openGate({ kind: 'question', gate, settle })
          request.signal?.addEventListener('abort', onAbort, { once: true })
          // A signal that aborted before the listener existed never emits, so the
          // state has to be read once after subscribing.
          if (request.signal?.aborted === true) onAbort()
        })
      }),
    ],
  }
}
