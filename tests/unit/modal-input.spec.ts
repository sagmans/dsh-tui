import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ProcessTerminal } from '@earendil-works/pi-tui'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { GATE_WAIT_KEY } from '@/herdr/constants.ts'
import type { HerdrReporter } from '@/herdr/reporter.ts'
import { defaultKeymap } from '@/input/actions.ts'
import { createModalInput, type Picker } from '@/surface/modal-input.ts'
import type { GateInputBar } from '@/ui/gate-input.ts'
import { POPUP_MAX_HEIGHT, popupRowBudget, popupWidth } from '@/ui/picker-card.ts'
import type { PickerAction, PickerCard } from '@/ui/picker.ts'
import type { PromptBar } from '@/ui/prompt.ts'
import { createTheme } from '@/theme.ts'
import type { WarningSafeTui } from '@/terminal/warning-screen.ts'

const SESSION = 'tui-session-1' as SessionId
const ESCAPE = '\x1b'
const ENTER = '\r'
/** The fixture's terminal size, which the popup's own box is derived from. */
const COLUMNS = 80
const ROWS = 24
/** The gap the popup keeps from the screen edge. */
const POPUP_MARGIN = 1

/** A menu with no rows: what opening one claims is the whole point here. */
function fakePicker(title: string): Picker {
  const card = (): PickerCard => ({ title, note: undefined, rows: [], filter: '', hint: '', above: 0, below: 0 })
  return { handleKey: () => ({ kind: 'cancel' }), card, setNote: () => {} }
}

/** A menu whose every press answers with the action the case scripts, and whose refusals are recorded. */
function scriptedPicker(): Picker & { action: PickerAction | undefined; readonly notes: string[]; readonly windows: number[] } {
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
  readonly ports: Parameters<typeof createModalInput>[1]
  /** The approval waterfall, once the surface has registered it. */
  readonly approval: () => Waterfall | undefined
  /** The question waterfall, once the surface has registered it. */
  readonly questions: () => Waterfall | undefined
}

function fixture(): Fixture {
  const waits: WaitCall[] = []
  const renders: number[] = []
  const focus: (unknown | null)[] = []
  const overlays: OverlayCall[] = []
  const promptCalls: string[] = []
  const handlers = new Map<string, Waterfall>()
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
    ports,
    approval: () => handlers.get('approval/request'),
    questions: () => handlers.get('user-questions/request'),
  }
}

/** Walk the surface's own list first: that is the moment the waterfalls this spec asks for come to exist. */
function registerListeners(modals: ReturnType<typeof createModalInput>): void {
  for (const register of modals.requestListeners()) void register
}

function approvalWaterfall(modals: ReturnType<typeof createModalInput>, given: Fixture): Waterfall {
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
function requestApproval(
  modals: ReturnType<typeof createModalInput>,
  given: Fixture,
  request: Record<string, unknown> = {},
): unknown {
  const approval = approvalWaterfall(modals, given)
  return approval({ agent: { id: SESSION }, toolName: 'bash', reason: 'needs network', ...request }, () => undefined)
}

function requestQuestions(
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

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

describe('createModalInput herdr waits', () => {
  it('claims no wait for a menu the reader opened', async () => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)

    const opened = modals.openPicker(fakePicker('Model'))
    modals.handleKey(ESCAPE)
    await opened

    // Herdr answers a transition into blocked with a needs-attention
    // notification and its sound, in the foreground pane as well as behind it, so
    // a menu the reader opened themselves must not claim one: the row would ring
    // for their own navigation and read as an agent stuck on a decision it never
    // asked for.
    expect(given.waits).toEqual([])
  })

  it('claims a gate as the wait it is, and gives it back when answered', () => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)

    requestApproval(modals, given)
    expect(given.waits).toEqual([{ kind: 'block', key: GATE_WAIT_KEY, message: expect.stringContaining('bash') }])

    modals.handleKey('y')
    expect(given.waits.at(-1)).toEqual({ kind: 'unblock', key: GATE_WAIT_KEY, message: undefined })
  })

  it('leaves a gate the only wait while a menu is open behind it', async () => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)

    // The order the surface can actually reach: a menu the reader opened is still
    // up when the agent asks for an approval, and the gate takes the keyboard
    // from it until it is answered.
    const opened = modals.openPicker(fakePicker('Model'))
    requestApproval(modals, given)
    modals.handleKey('y')
    modals.handleKey(ESCAPE)
    await opened

    // One wait was claimed and one given back, both the gate's: a menu settling
    // must not read as a decision the agent is still owed having been answered.
    expect(given.waits.map(call => `${call.kind}:${call.key}`)).toEqual([`block:${GATE_WAIT_KEY}`, `unblock:${GATE_WAIT_KEY}`])
    expect(modals.gateCard()).toBeUndefined()
    expect(modals.pickerCard()).toBeUndefined()
  })
})

describe('createModalInput gates', () => {
  it('keeps a gate open and repaints for a press it does not answer', () => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)
    requestApproval(modals, given)

    const before = given.renders.length
    expect(modals.handleKey('x')).toBe(true)
    expect(given.renders.length).toBe(before + 1)
    expect(modals.gateCard()?.kind).toBe('approval')
  })

  it('turns an aborted approval into cancelled and gives the keyboard back', async () => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)
    const controller = new AbortController()
    const answered = requestApproval(modals, given, { signal: controller.signal })

    controller.abort()
    await expect(answered as Promise<unknown>).resolves.toBe('cancelled')
    expect(modals.gateCard()).toBeUndefined()
    expect(given.editor.disableSubmit).toBe(false)
    expect(given.waits.map(call => `${call.kind}:${call.key}`)).toEqual([`block:${GATE_WAIT_KEY}`, `unblock:${GATE_WAIT_KEY}`])
  })

  it('borrows the bar for a question, answers in the seam shape, and gives it back', async () => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)
    const controller = new AbortController()
    const call = requestQuestions(modals, given, {
      agent: { id: SESSION },
      questions: [{ id: 'q1', question: 'Which one?' }],
      signal: controller.signal,
    })

    // A question is answered in the reader's own editor, which is why the bar is
    // borrowed before the gate is built and given back only once it closes.
    expect(given.promptCalls).toEqual(['borrow'])
    expect(given.editor.focused).toBe(true)
    expect(given.focus.at(-1)).toBeNull()

    // A press the gate does not claim is the editor's; it repaints rather than
    // settling an answer nobody gave.
    const before = given.renders.length
    expect(modals.handleKey('x')).toBe(true)
    expect(given.renders.length).toBe(before + 1)
    expect(modals.gateCard()?.kind).toBe('question')

    given.editor.setText('ship it')
    expect(modals.handleKey(ENTER)).toBe(true)
    await expect(call.answer as Promise<unknown>).resolves.toEqual({
      answers: [{ id: 'q1', selected: [], custom: 'ship it' }],
    })
    expect(given.promptCalls).toEqual(['borrow', 'giveBack'])
    expect(given.focus.at(-1)).toBe(given.ports.editor)
    expect(modals.gateCard()).toBeUndefined()

    // The answered call is done with the signal: a later abort must not settle
    // the same question a second time.
    const settled = given.promptCalls.length
    controller.abort()
    await settle()
    expect(given.promptCalls.length).toBe(settled)
  })

  it('answers a listed row without inventing a custom answer', async () => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)
    const call = requestQuestions(modals, given, {
      agent: { id: SESSION },
      questions: [{ id: 'q1', question: 'Deploy?', options: [{ label: 'ship' }] }],
    })

    // A picked label is the whole answer: the seam reads an answer with no typed
    // text as the option itself, so no custom field may be sent with it.
    expect(modals.handleKey('1')).toBe(true)
    expect(modals.handleKey(ENTER)).toBe(true)
    await expect(call.answer as Promise<unknown>).resolves.toEqual({
      answers: [{ id: 'q1', selected: ['ship'] }],
    })
  })

  it('ignores an abort that arrives after the reader answered the approval', () => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)
    const controller = new AbortController()
    requestApproval(modals, given, { signal: controller.signal })

    modals.handleKey('y')
    const waitsAfterAnswer = given.waits.length
    controller.abort()

    // The gate is already answered and closed: a late abort must not read as a
    // second decision, which would give back a wait the row no longer holds.
    expect(given.waits.length).toBe(waitsAfterAnswer)
    expect(modals.gateCard()).toBeUndefined()
  })

  it('cancels a question whose caller aborts and answers it with nothing', async () => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)
    const controller = new AbortController()
    const call = requestQuestions(modals, given, {
      agent: { id: SESSION },
      questions: [{ id: 'q1', question: 'Which one?' }],
      signal: controller.signal,
    })

    controller.abort()
    await expect(call.answer as Promise<unknown>).resolves.toEqual({ answers: [] })
    expect(modals.gateCard()).toBeUndefined()
    expect(given.promptCalls).toEqual(['borrow', 'giveBack'])
    expect(given.editor.disableSubmit).toBe(false)
  })

  it('releases a question the caller aborted before the gate existed', async () => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)
    const call = requestQuestions(modals, given, {
      agent: { id: SESSION },
      questions: [{ id: 'q1', question: 'Which one?' }],
      signal: AbortSignal.abort(),
    })

    await expect(call.answer as Promise<unknown>).resolves.toEqual({ answers: [] })
    expect(modals.gateCard()).toBeUndefined()
    expect(given.promptCalls).toEqual(['borrow', 'giveBack'])
  })

  it('leaves the gate that took the keyboard in place when the question behind it aborts', async () => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)
    const controller = new AbortController()
    const call = requestQuestions(modals, given, {
      agent: { id: SESSION },
      questions: [{ id: 'q1', question: 'Which one?' }],
      signal: controller.signal,
    })

    // An approval can arrive while a question is up, and the gate that holds the
    // keyboard now is the approval: the aborted question must answer its caller
    // without closing a gate that belongs to someone else.
    requestApproval(modals, given)
    controller.abort()
    await expect(call.answer as Promise<unknown>).resolves.toEqual({ answers: [] })
    expect(modals.gateCard()?.kind).toBe('approval')
  })

  const passthrough: [string, Record<string, unknown>][] = [
    ['another session', { agent: { id: 'tui-session-2' }, questions: [{ id: 'q1' }] }],
    ['no questions at all', { agent: { id: SESSION }, questions: [] }],
  ]

  it.each(passthrough)('hands a question request through untouched for %s', (_name, request) => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)

    const call = requestQuestions(modals, given, request)
    expect(call.next()).toBe(1)
    expect(modals.gateCard()).toBeUndefined()
    expect(given.promptCalls).toEqual([])
  })

  it('hands an approval for another session through untouched', () => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)
    const approval = approvalWaterfall(modals, given)

    let nexts = 0
    approval({ agent: { id: 'tui-session-2' }, toolName: 'bash' }, () => {
      nexts += 1
    })
    expect(nexts).toBe(1)
    expect(modals.gateCard()).toBeUndefined()
    expect(given.waits).toEqual([])
  })
})

describe('createModalInput pickers', () => {
  it('hands back a press when no modal holds the keyboard', () => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)

    expect(modals.handleKey(ESCAPE)).toBe(false)
    expect(given.renders).toEqual([])
  })

  it('settles an inline menu on the id it picked and restores the editor', async () => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)
    const picker = scriptedPicker()
    const opened = modals.openPicker(picker)

    expect(modals.pickerCard()).toEqual(picker.card())
    expect(given.editor.disableSubmit).toBe(true)
    expect(given.focus.at(-1)).toBeNull()

    const before = given.renders.length
    expect(modals.handleKey('j')).toBe(true)
    expect(given.renders.length).toBe(before + 1)

    picker.action = { kind: 'pick', id: 'kept' }
    expect(modals.handleKey(ENTER)).toBe(true)
    await expect(opened).resolves.toBe('kept')
    expect(modals.pickerCard()).toBeUndefined()
    expect(given.editor.disableSubmit).toBe(false)
    expect(given.focus.at(-1)).toBe(given.ports.editor)
  })

  it('hides a popup menu when it settles and draws no inline card for it', async () => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)
    const picker = scriptedPicker()
    const opened = modals.openPicker(picker, undefined, 'popup')

    // A popup keeps its rows to itself, so the transcript card is only for the
    // inline placement; the box over the work is hidden the moment it settles.
    expect(modals.pickerCard()).toBeUndefined()
    expect(given.overlays).toHaveLength(1)
    expect(given.overlays[0]!.options).toEqual({
      width: popupWidth(COLUMNS),
      maxHeight: POPUP_MAX_HEIGHT,
      anchor: 'center',
      margin: POPUP_MARGIN,
      nonCapturing: true,
    })

    // The box draws the list itself, at the row budget the terminal's height affords.
    const component = given.overlays[0]!.component as { render(width: number): string[] }
    component.render(popupWidth(COLUMNS))
    expect(picker.windows).toEqual([popupRowBudget(ROWS)])

    picker.action = { kind: 'cancel' }
    expect(modals.handleKey(ESCAPE)).toBe(true)
    await expect(opened).resolves.toBeUndefined()
    expect(given.overlays[0]!.hidden).toBe(1)
  })

  it('keeps a refused row in the menu with the note it was refused for', async () => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)
    const picker = scriptedPicker()
    const verdicts: ((reason: string | undefined) => void)[] = []
    const asked: string[] = []
    const opened = modals.openPicker(picker, id => {
      asked.push(id)
      return new Promise<string | undefined>(resolve => {
        verdicts.push(resolve)
      })
    })

    picker.action = { kind: 'pick', id: 'busy' }
    expect(modals.handleKey(ENTER)).toBe(true)
    expect(asked).toEqual(['busy'])

    // A second pick while the first verdict is being read must not race it.
    picker.action = { kind: 'pick', id: 'other' }
    expect(modals.handleKey(ENTER)).toBe(true)
    expect(asked).toEqual(['busy'])

    verdicts.shift()!('already running')
    await settle()
    expect(picker.notes).toEqual(['already running'])
    expect(modals.pickerCard()?.note).toBe('already running')

    picker.action = { kind: 'pick', id: 'busy' }
    expect(modals.handleKey(ENTER)).toBe(true)
    verdicts.shift()!(undefined)
    await expect(opened).resolves.toBe('busy')
  })

  it('settles a crashed check as a refusal and leaves no rejection unhandled', async () => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)
    const picker = scriptedPicker()
    const rejections: unknown[] = []
    const onRejection = (error: unknown): void => {
      rejections.push(error)
    }
    process.on('unhandledRejection', onRejection)
    const opened = modals.openPicker(picker, () => Promise.reject(new Error('vet-port-crashed')))

    picker.action = { kind: 'pick', id: 'busy' }
    expect(modals.handleKey(ENTER)).toBe(true)
    await expect(opened).resolves.toBeUndefined()
    // A rejection the check leaked would only be reported as unhandled on a later tick.
    await settle()
    process.removeListener('unhandledRejection', onRejection)

    // A crashed check cannot vouch for the row and has no refusal text to keep
    // the menu open with, so the pick settles refused and the keyboard returns.
    expect(rejections).toEqual([])
    expect(modals.pickerCard()).toBeUndefined()
    expect(picker.notes).toEqual([])
    expect(given.editor.disableSubmit).toBe(false)
    expect(given.focus.at(-1)).toBe(given.ports.editor)
    expect(modals.handleKey('j')).toBe(false)
  })

  it('answers a cancelled menu at once and ignores the verdict that arrives later', async () => {
    const given = fixture()
    const modals = createModalInput(given.ctx, given.ports)
    const picker = scriptedPicker()
    let verdict: ((reason: string | undefined) => void) | undefined
    const opened = modals.openPicker(picker, () => new Promise<string | undefined>(resolve => {
      verdict = resolve
    }))

    picker.action = { kind: 'pick', id: 'busy' }
    modals.handleKey(ENTER)

    // Cancelling must not wait for a check the reader has walked away from.
    picker.action = { kind: 'cancel' }
    expect(modals.handleKey(ESCAPE)).toBe(true)
    await expect(opened).resolves.toBeUndefined()

    const afterCancel = given.renders.length
    verdict!('too late')
    await settle()
    expect(given.renders.length).toBe(afterCancel)
    expect(picker.notes).toEqual([])
  })
})
