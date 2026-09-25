import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ProcessTerminal } from '@earendil-works/pi-tui'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { GATE_WAIT_KEY } from '@/herdr/constants.ts'
import type { HerdrReporter } from '@/herdr/reporter.ts'
import { defaultKeymap } from '@/input/actions.ts'
import { createModalInput, type Picker } from '@/surface/modal-input.ts'
import type { GateInputBar } from '@/ui/gate-input.ts'
import type { PickerCard } from '@/ui/picker.ts'
import type { PromptBar } from '@/ui/prompt.ts'
import type { TuiTheme } from '@/theme.ts'
import type { WarningSafeTui } from '@/terminal/warning-screen.ts'

const SESSION = 'tui-session-1' as SessionId
const ESCAPE = '\x1b'

/** A menu with no rows: what opening one claims is the whole point here. */
function fakePicker(title: string): Picker {
  const card = (): PickerCard => ({ title, note: undefined, rows: [], filter: '', hint: '', above: 0, below: 0 })
  return { handleKey: () => ({ kind: 'cancel' }), card, setNote: () => {} }
}

interface WaitCall {
  readonly kind: 'block' | 'unblock'
  readonly key: string
  readonly message: string | undefined
}

interface Fixture {
  readonly waits: WaitCall[]
  readonly ctx: Context
  readonly ports: Parameters<typeof createModalInput>[1]
  /** The approval waterfall, once the surface has registered it. */
  readonly approval: () => ((request: unknown, next: () => unknown) => unknown) | undefined
}

function fixture(): Fixture {
  const waits: WaitCall[] = []
  const handlers = new Map<string, (request: never, next: () => never) => unknown>()
  const herdr: HerdrReporter = {
    enabled: true,
    driver: () => {},
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
    on: (event: string, handler: (request: never, next: () => never) => unknown) => {
      handlers.set(event, handler)
      return () => {}
    },
  } as unknown as Context
  const editor = { disableSubmit: false, focused: false }
  const ports = {
    herdr,
    editor: editor as unknown as GateInputBar,
    tui: { setFocus: () => {}, requestRender: () => {} } as unknown as WarningSafeTui,
    terminal: { rows: 24, columns: 80 } as unknown as ProcessTerminal,
    theme: {} as TuiTheme,
    keymap: () => defaultKeymap(),
    promptBar: { giveBack: () => {} } as unknown as PromptBar,
    refreshCompletion: () => {},
    activeSession: () => SESSION,
  }
  return {
    waits,
    ctx,
    ports,
    approval: () => handlers.get('approval/request') as ((request: unknown, next: () => unknown) => unknown) | undefined,
  }
}

/**
 * Ask the surface for an approval the way the harness does.
 *
 * The waterfalls are handed back as registrations rather than installed by the
 * constructor, so the surface's own list is walked first: that is the moment the
 * listener this asks for comes to exist.
 */
function requestApproval(modals: ReturnType<typeof createModalInput>, given: Fixture): void {
  for (const register of modals.requestListeners()) void register
  const approval = given.approval()
  if (approval === undefined) throw new Error('the approval listener was never registered')
  void approval({ agent: { id: SESSION }, toolName: 'bash', reason: 'needs network' }, () => undefined)
}

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
