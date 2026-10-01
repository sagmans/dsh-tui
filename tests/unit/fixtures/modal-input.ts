import type { Context } from '@deepseek-ai/cordis'
import type { ProcessTerminal } from '@earendil-works/pi-tui'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { HerdrReporter } from '@/herdr/reporter.ts'
import { defaultKeymap } from '@/input/actions.ts'
import { createModalInput, type Picker } from '@/surface/modal-input.ts'
import type { GateInputBar } from '@/ui/gate-input.ts'
import type { PickerAction, PickerCard } from '@/ui/picker.ts'
import type { PromptBar } from '@/ui/prompt.ts'
import { createTheme } from '@/theme.ts'
import type { WarningSafeTui } from '@/terminal/warning-screen.ts'

export const SESSION = 'tui-session-1' as SessionId
export const ESCAPE = '\x1b'
export const ENTER = '\r'
/** The fixture's terminal size, which the popup's own box is derived from. */
export const COLUMNS = 80
export const ROWS = 24
/** The gap the popup keeps from the screen edge. */
export const POPUP_MARGIN = 1

/** A menu with no rows: what opening one claims is the whole point here. */
export function fakePicker(title: string): Picker {
  const card = (): PickerCard => ({ title, note: undefined, rows: [], filter: '', hint: '', above: 0, below: 0 })
  return { handleKey: () => ({ kind: 'cancel' }), card, setNote: () => {} }
}

/** A menu whose every press answers with the action the case scripts, and whose refusals are recorded. */
export function scriptedPicker(): Picker & { action: PickerAction | undefined; readonly notes: string[]; readonly windows: number[] } {
  const notes: string[] = []
  const windows: number[] = []
  const picker: Picker & { action: PickerAction | undefined; readonly notes: string[]; readonly windows: number[] } = {
    action: undefined,
    notes,
    windows,
    handleKey: () => picker.action,
    card: (window?: number): PickerCard => {
      // A popup asks for the row budget the box can afford; recording it is how a
      // case sees the terminal's own height reach the list.
      if (window !== undefined) windows.push(window)
      return {
        title: 'History',
        note: notes.at(-1),
        rows: [],
        filter: '',
        hint: '',
        above: 0,
        below: 0,
      }
    },
    setNote: (text: string | undefined) => {
      notes.push(text ?? '')
    },
  }
  return picker
}

interface WaitCall {
  readonly kind: 'block' | 'unblock'
  readonly key: string
  readonly message: string | undefined
}

/** The waterfall the surface registered for one event. */
type Waterfall = (request: unknown, next: () => unknown) => unknown

interface OverlayCall {
  readonly component: unknown
  readonly options: unknown
  hidden: number
}

/** The editor the surface hands to a question gate, holding whatever an answer typed into it. */
interface EditorFake {
  disableSubmit: boolean
  focused: boolean
  text: string
  getExpandedText(): string
  setText(text: string): void
  handleInput(data: string): void
  render(): string[]
  setMode(): void
}

interface Fixture {
  readonly waits: WaitCall[]
  readonly renders: number[]
  readonly focus: (unknown | null)[]
  readonly overlays: OverlayCall[]
  /** The prompt bar's borrow and giveBack calls, in order. */
  readonly promptCalls: string[]
  readonly editor: EditorFake
  readonly ctx: Context
  readonly dispose: () => void
  readonly ports: Parameters<typeof createModalInput>[1]
  /** The approval waterfall, once the surface has registered it. */
  readonly approval: () => Waterfall | undefined
  /** The question waterfall, once the surface has registered it. */
  readonly questions: () => Waterfall | undefined
}

export function fixture(): Fixture {
  const waits: WaitCall[] = []
  const renders: number[] = []
  const focus: (unknown | null)[] = []
  const overlays: OverlayCall[] = []
  const promptCalls: string[] = []
  const handlers = new Map<string, Waterfall>()
  const disposals: (() => void)[] = []
  const herdr: HerdrReporter = {
    enabled: true,
    driver: () => {},
    background: () => {},
    block: (key, message) => {
      waits.push({ kind: 'block', key, message })
    },
    unblock: key => {
      waits.push({ kind: 'unblock', key, message: undefined })
    },
    session: () => {},
    publish: () => {},
    releaseSync: () => {},
    release: async () => {},
    registerExitRelease: () => () => {},
  }
  const ctx = {
    effect: (build: () => () => void) => {
      const disposal = build()
      disposals.push(disposal)
      return disposal
    },
    on: (event: string, handler: Waterfall) => {
      handlers.set(event, handler)
      return () => {}
    },
  } as unknown as Context
  const editor: EditorFake = {
    disableSubmit: false,
    focused: false,
    text: '',
    getExpandedText: () => editor.text,
    setText: text => {
      editor.text = text
    },
    handleInput: data => {
      editor.text += data
    },
    render: () => [],
    setMode: () => {},
  }
  const ports = {
    herdr,
    editor: editor as unknown as GateInputBar,
    tui: {
      setFocus: (component: unknown | null) => {
        focus.push(component)
      },
      requestRender: () => {
        renders.push(1)
      },
      showOverlay: (component: unknown, options: unknown) => {
        const call: OverlayCall = { component, options, hidden: 0 }
        overlays.push(call)
        return {
          hide: () => {
            call.hidden += 1
          },
        }
      },
    } as unknown as WarningSafeTui,
    terminal: { rows: ROWS, columns: COLUMNS } as unknown as ProcessTerminal,
    theme: createTheme('none'),
    keymap: () => defaultKeymap(),
    promptBar: {
      borrow: (build: () => unknown) => {
        promptCalls.push('borrow')
        return build()
      },
      giveBack: () => {
        promptCalls.push('giveBack')
      },
    } as unknown as PromptBar,
    refreshCompletion: () => {},
    activeSession: () => SESSION,
  }
  return {
    waits,
    renders,
    focus,
    overlays,
    promptCalls,
    editor,
    ctx,
    dispose: () => disposals.forEach(dispose => dispose()),
    ports,
    approval: () => handlers.get('approval/request'),
    questions: () => handlers.get('user-questions/request'),
  }
}

/** Walk the surface's own list first: that is the moment the waterfalls this spec asks for come to exist. */
function registerListeners(modals: ReturnType<typeof createModalInput>): void {
  for (const register of modals.requestListeners()) void register
}

export function approvalWaterfall(modals: ReturnType<typeof createModalInput>, given: Fixture): Waterfall {
  registerListeners(modals)
  const approval = given.approval()
  if (approval === undefined) throw new Error('the approval listener was never registered')
  return approval
}

/**
 * Ask the surface for an approval the way the harness does.
 *
 * The waterfalls are handed back as registrations rather than installed by the
 * constructor, so the surface's own list is walked first: that is the moment the
 * listener this asks for comes to exist.
 */
export function requestApproval(
  modals: ReturnType<typeof createModalInput>,
  given: Fixture,
  request: Record<string, unknown> = {},
): unknown {
  const approval = approvalWaterfall(modals, given)
  return approval({ agent: { id: SESSION }, toolName: 'bash', reason: 'needs network', ...request }, () => undefined)
}

export function requestQuestions(
  modals: ReturnType<typeof createModalInput>,
  given: Fixture,
  request: Record<string, unknown>,
): { readonly answer: unknown; readonly next: () => number } {
  registerListeners(modals)
  const questions = given.questions()
  if (questions === undefined) throw new Error('the question listener was never registered')
  let nexts = 0
  const answer = questions({ signal: undefined, ...request }, () => {
    nexts += 1
  })
  return { answer, next: () => nexts }
}

export const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
