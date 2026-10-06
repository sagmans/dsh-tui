/** Native PTY output can restart emulator blink; software caret timing must ignore unrelated renders. */
export const SOFTWARE_CURSOR_MODE = 'software'
export const NATIVE_CURSOR_MODE = 'native'
export const CURSOR_MODES = [SOFTWARE_CURSOR_MODE, NATIVE_CURSOR_MODE] as const
export type CursorMode = (typeof CURSOR_MODES)[number]
const CURSOR_BLINK_HALF_PERIOD_MS = 500

/** Standalone editors retain native presentation unless their terminal owner supplies a clock. */
export interface CursorPresentation {
  readonly mode: CursorMode
  visible(): boolean
  activity(): void
}

/** Only the terminal owner may start a writer or transfer its focus and lifetime. */
export interface CursorController extends CursorPresentation {
  start(): void
  stop(): void
  setTerminalFocused(focused: boolean): void
  setEditorFocused(focused: boolean): void
}

/** Existing standalone callers have no terminal lifecycle in which to own a timer. */
export const NATIVE_CURSOR_PRESENTATION: CursorPresentation = Object.freeze({
  mode: NATIVE_CURSOR_MODE,
  visible: () => false,
  activity: () => {},
})

/** A single cancellable timeout belongs to the surface, never the status ticker or transcript. */
export function createCursorController(mode: CursorMode, requestRender: () => void): CursorController {
  let started = false
  let terminalFocused = true
  let editorFocused = false
  let phase = true
  let timer: ReturnType<typeof setTimeout> | undefined

  const active = (): boolean => mode === SOFTWARE_CURSOR_MODE && started && terminalFocused && editorFocused
  const cancel = (): void => {
    clearTimeout(timer)
    timer = undefined
  }
  const schedule = (): void => {
    if (!active()) return
    timer = setTimeout(() => {
      timer = undefined
      if (!active()) return
      phase = !phase
      requestRender()
      schedule()
    }, CURSOR_BLINK_HALF_PERIOD_MS)
    // A caret must not keep an otherwise finished host alive.
    timer.unref()
  }
  const restart = (): void => {
    cancel()
    phase = true
    if (active()) schedule()
    if (started && mode === SOFTWARE_CURSOR_MODE) requestRender()
  }

  return {
    mode,
    visible: () => active() && phase,
    activity: () => { if (active()) restart() },
    start: () => {
      if (started) return
      started = true
      // Stopped stdin cannot report focus changes; resume uses native startup’s focused-until-report assumption.
      terminalFocused = true
      restart()
    },
    stop: () => {
      started = false
      cancel()
    },
    setTerminalFocused: focused => {
      if (terminalFocused === focused) return
      terminalFocused = focused
      restart()
    },
    setEditorFocused: focused => {
      if (editorFocused === focused) return
      editorFocused = focused
      restart()
    },
  }
}
