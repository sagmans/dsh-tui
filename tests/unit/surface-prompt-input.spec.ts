/**
 * The prompt bar's borrowed state at the boundary its port object exposes: which
 * presses the surface answers itself, the chord it holds, and the menu a borrow
 * hands the bar.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { getKeybindings, type CombinedAutocompleteProvider } from '@earendil-works/pi-tui'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { DEFAULT_PREFIX_KEYS, DEFAULT_PREFIX_WINDOW_S } from '@/input/keymap.ts'
import { resolveKeymap, type Keymap } from '@/input/actions.ts'
import type { RegisteredCommand } from '@/input/completion.ts'
import type { Submission } from '@/input/submission.ts'
import type { WarningSafeTui } from '@/terminal/warning-screen.ts'
import { createPromptInput, type PromptInput, type PromptInputPorts } from '@/surface/prompt-input.ts'
import type { BoxedEditor } from '@/ui/editor.ts'
import type { GateInputBar } from '@/ui/gate-input.ts'
import { PromptBar } from '@/ui/prompt.ts'

/** The bytes a terminal sends for the surface's own keys; the tests press the real presses. */
const CTRL_C = '\x03'
const CTRL_D = '\x04'
const CTRL_B = '\x02'
const CTRL_O = '\x0f'
const CTRL_R = '\x12'
const CTRL_T = '\x14'
const CTRL_X = '\x18'
const CTRL_Y = '\x19'
const SHIFT_TAB = '\x1b[Z'
/** What the terminal sends as the release half of a press once key events are reported. */
const RELEASE_CTRL_O = '\x1b[111;5:3u'

const COMMANDS: readonly RegisteredCommand[] = [{ name: 'compact', description: 'compact the context' }]

interface State {
  keymap: Keymap
  queued: readonly string[]
  turnRunning: boolean
  viewingChild: boolean
  overlay: boolean
  /** Whether the open menu claims the press before the surface's own keys do. */
  modalConsumes: boolean
  agent: Agent | undefined
  commands: readonly RegisteredCommand[] | undefined
}

interface EditorStub {
  text: string
  readonly history: string[]
  readonly providers: CombinedAutocompleteProvider[]
  onSubmit: ((text: string) => void) | undefined
  getExpandedText(): string
  setText(text: string): void
  addToHistory(text: string): void
  setAutocompleteProvider(provider: CombinedAutocompleteProvider): void
}

interface Recorder {
  readonly notices: string[]
  readonly runs: Submission[]
  readonly recorded: string[]
  readonly exits: number[]
  readonly trace: string[]
  readonly handlers: Map<string, () => void>
  readonly listeners: ((data: string) => { consume: true } | undefined)[]
  readonly modal: string[]
  disposers: number
  releases: number
  renders: number
}

interface Harness {
  readonly input: PromptInput
  readonly state: State
  readonly rec: Recorder
  readonly editor: EditorStub
  readonly bar: PromptBar
  /** Put a menu on the bar without recording it as a call the module made. */
  seedProvider(provider: CombinedAutocompleteProvider): void
  readonly latestProvider: () => CombinedAutocompleteProvider | undefined
  readonly press: (data: string) => { consume: true } | undefined
  readonly suggestions: (line: string) => Promise<string[]>
}

function fixture(): Harness {
  const state: State = {
    keymap: resolveKeymap({}),
    queued: [],
    turnRunning: false,
    viewingChild: false,
    overlay: false,
    modalConsumes: false,
    agent: undefined,
    commands: undefined,
  }
  const rec: Recorder = { notices: [], runs: [], recorded: [], exits: [], trace: [], handlers: new Map(), listeners: [], modal: [], disposers: 0, releases: 0, renders: 0 }
  let provider: CombinedAutocompleteProvider | undefined
  const editor: EditorStub = {
    text: '',
    history: [],
    providers: [],
    onSubmit: undefined,
    getExpandedText: () => editor.text,
    setText: (text: string) => {
      editor.text = text
    },
    addToHistory: (text: string) => {
      editor.history.push(text)
    },
    setAutocompleteProvider: (chosen: CombinedAutocompleteProvider) => {
      provider = chosen
      editor.providers.push(chosen)
    },
  }
  const bar = new PromptBar(editor as unknown as BoxedEditor)
  const ctx = {
    on: (event: string, handler: () => void) => {
      rec.handlers.set(event, handler)
      return () => {
        rec.disposers += 1
      }
    },
  } as unknown as Context
  const tui = {
    addInputListener: (listener: (data: string) => { consume: true } | undefined) => {
      rec.listeners.push(listener)
      return () => {
        rec.releases += 1
      }
    },
    requestRender: () => {
      rec.renders += 1
    },
    hasOverlay: () => state.overlay,
  } as unknown as WarningSafeTui

  const ports: PromptInputPorts = {
    keymap: () => state.keymap,
    prefixKeys: () => DEFAULT_PREFIX_KEYS,
    prefixWindowMs: () => DEFAULT_PREFIX_WINDOW_S * 1000,
    tui: () => tui,
    editor: () => editor as unknown as GateInputBar,
    promptBar: () => bar,
    modalHandleKey: (data: string) => {
      rec.modal.push(data)
      return state.modalConsumes
    },
    toggleCards: () => {
      rec.trace.push('toggleCards')
    },
    toggleSubCalls: () => {
      rec.trace.push('toggleSubCalls')
    },
    toggleReasoning: () => {
      rec.trace.push('toggleReasoning')
    },
    openEffortPicker: () => {
      rec.trace.push('effort')
    },
    openHistoryPicker: () => {
      rec.trace.push('history')
    },
    back: () => {
      rec.trace.push('back')
    },
    queuedPrompts: () => state.queued,
    turnRunning: () => state.turnRunning,
    viewingChild: () => state.viewingChild,
    interrupt: () => {
      rec.trace.push('interrupt')
    },
    notice: message => {
      rec.notices.push(message)
    },
    requestExit: code => {
      rec.exits.push(code)
    },
    recordPrompt: text => {
      rec.recorded.push(text)
    },
    runSubmission: submission => {
      rec.runs.push(submission)
    },
    drivenAgent: () => state.agent,
    registeredCommands: () => state.commands,
  }

  const input = createPromptInput(ctx, ports)
  const suggestions = async (line: string): Promise<string[]> => {
    if (provider === undefined) return []
    const found = await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal })
    return found?.items.map(item => item.value) ?? []
  }

  return {
    input,
    state,
    rec,
    editor,
    bar,
    seedProvider: (seeded: CombinedAutocompleteProvider) => {
      provider = seeded
      editor.providers.length = 0
    },
    latestProvider: () => provider,
    // The surface registers the listener once its terminal exists; every press in
    // this spec arrives at the boundary the reader's key does.
    press: (data: string) => {
      if (rec.listeners.length === 0) input.inputListener()
      return rec.listeners.at(-1)?.(data)
    },
    suggestions,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

/** A fixture whose agent is up and whose registry offers one command. */
function installed(): Harness {
  const h = fixture()
  h.state.agent = {} as Agent
  h.state.commands = COMMANDS
  h.input.installCompletion()
  return h
}

describe("the bar's own presses", () => {
  it('drops the release half of a press before any menu sees it', () => {
    const h = fixture()
    h.state.modalConsumes = true
    // The library drops the release only for the focused component, so a listener
    // that acted on both halves would answer one press twice.
    expect(h.press(RELEASE_CTRL_O)).toBeUndefined()
    expect(h.rec.modal).toEqual([])
    expect(h.rec.trace).toEqual([])
    expect(h.rec.renders).toBe(0)
  })

  it('gives a press to the open menu first', () => {
    const h = fixture()
    h.state.modalConsumes = true
    expect(h.press(CTRL_O)).toEqual({ consume: true })
    expect(h.rec.trace).toEqual([])
    expect(h.rec.renders).toBe(0)
  })

  it('hands back a press nothing answers', () => {
    const h = fixture()
    expect(h.press('x')).toBeUndefined()
    expect(h.rec.modal).toEqual(['x'])
    expect(h.rec.trace).toEqual([])
    expect(h.rec.renders).toBe(0)
  })

  it('consumes the prefix and names it in the footer', () => {
    const h = fixture()
    expect(h.press(CTRL_X)).toEqual({ consume: true })
    expect(h.input.chordHint()).toBe('ctrl+x')
    expect(h.rec.renders).toBe(1)

    // A key that finishes no chord is handed back rather than swallowed.
    expect(h.press('z')).toBeUndefined()
    expect(h.input.chordHint()).toBeUndefined()
    expect(h.rec.runs).toEqual([])
    expect(h.rec.renders).toBe(1)
  })

  it('runs the command a chord stands for', () => {
    const h = fixture()
    h.press(CTRL_X)
    expect(h.press('m')).toEqual({ consume: true })
    expect(h.rec.runs).toEqual([{ kind: 'model', argument: '' }])
    expect(h.input.chordHint()).toBeUndefined()
    expect(h.rec.renders).toBe(2)
  })

  it('repaints when the chord window closes', async () => {
    vi.useFakeTimers()
    const h = fixture()
    h.press(CTRL_X)
    expect(h.rec.renders).toBe(1)
    await vi.advanceTimersByTimeAsync(DEFAULT_PREFIX_WINDOW_S * 1000)
    expect(h.input.chordHint()).toBeUndefined()
    expect(h.rec.renders).toBe(2)
  })

  it('ends a chord the keymap it was armed under was replaced', () => {
    const h = fixture()
    h.press(CTRL_X)
    h.input.disarmChord()
    expect(h.input.chordHint()).toBeUndefined()
    expect(h.press('m')).toBeUndefined()
    expect(h.rec.runs).toEqual([])
  })

  it('registers its listener with the terminal and hands the disposer back', () => {
    const h = fixture()
    const off = h.input.inputListener()
    expect(h.rec.listeners).toHaveLength(1)
    off()
    expect(h.rec.releases).toBe(1)
  })

  it.each([
    ['ctrl+o', CTRL_O, 'toggleCards', 1],
    ['ctrl+y', CTRL_Y, 'toggleSubCalls', 1],
    ['shift+tab', SHIFT_TAB, 'toggleReasoning', 1],
    // A menu that opens paints itself, so the press must not repaint the frame
    // underneath it.
    ['ctrl+t', CTRL_T, 'effort', 0],
    ['ctrl+r', CTRL_R, 'history', 0],
    ['ctrl+b', CTRL_B, 'back', 0],
  ] as const)('answers %s itself', (_label, key, expected, renders) => {
    const h = fixture()
    expect(h.press(key)).toEqual({ consume: true })
    expect(h.rec.trace).toEqual([expected])
    expect(h.rec.renders).toBe(renders)
  })
})

describe('the cancel key', () => {
  it('empties the bar before it reaches for the agent', () => {
    const h = fixture()
    h.editor.text = 'half-written'
    h.state.turnRunning = true
    h.state.queued = ['queued']
    expect(h.press(CTRL_C)).toEqual({ consume: true })
    expect(h.editor.text).toBe('')
    expect(h.rec.trace).toEqual([])
    expect(h.rec.notices).toEqual([])
    expect(h.rec.renders).toBe(1)
  })

  it('hands queued prompts back to the bar as it interrupts', () => {
    const h = fixture()
    h.state.queued = ['first', 'second']
    expect(h.press(CTRL_C)).toEqual({ consume: true })
    expect(h.rec.trace).toEqual(['interrupt'])
    expect(h.editor.text).toBe('first\nsecond')
    expect(h.rec.notices).toEqual(['interrupt requested · 2 queued prompts back in the bar'])
  })

  it('names a single reclaimed prompt in the singular', () => {
    const h = fixture()
    h.state.queued = ['only']
    expect(h.press(CTRL_C)).toEqual({ consume: true })
    expect(h.rec.notices).toEqual(['interrupt requested · 1 queued prompt back in the bar'])
  })

  it('interrupts a running turn and leaves the bar alone', () => {
    const h = fixture()
    h.editor.text = ''
    h.state.turnRunning = true
    expect(h.press(CTRL_C)).toEqual({ consume: true })
    expect(h.rec.trace).toEqual(['interrupt'])
    expect(h.rec.notices).toEqual(['interrupt requested'])
  })

  it('leaves the child view instead of cancelling anything', () => {
    const h = fixture()
    h.state.viewingChild = true
    expect(h.press(CTRL_C)).toEqual({ consume: true })
    expect(h.rec.trace).toEqual(['back'])
    expect(h.rec.notices).toEqual([])
  })

  it('hands back a cancel press with nothing left to take', () => {
    const h = fixture()
    expect(h.press(CTRL_C)).toBeUndefined()
    expect(h.rec.trace).toEqual([])
    expect(h.rec.notices).toEqual([])
  })
})

describe('the quit key', () => {
  it('keeps the key for a bar that holds text', () => {
    const h = fixture()
    h.editor.text = 'draft'
    expect(h.press(CTRL_D)).toBeUndefined()
    expect(h.rec.exits).toEqual([])
  })

  it('keeps the key for an open overlay', () => {
    const h = fixture()
    h.state.overlay = true
    expect(h.press(CTRL_D)).toBeUndefined()
    expect(h.rec.exits).toEqual([])
  })

  it('cancels a running turn on the way out', () => {
    const h = fixture()
    h.state.turnRunning = true
    expect(h.press(CTRL_D)).toEqual({ consume: true })
    expect(h.rec.trace).toEqual(['interrupt'])
    expect(h.rec.exits).toEqual([0])
  })

  it('leaves an idle session', () => {
    const h = fixture()
    expect(h.press(CTRL_D)).toEqual({ consume: true })
    expect(h.rec.trace).toEqual([])
    expect(h.rec.exits).toEqual([0])
  })
})

describe('the completion the bar borrows', () => {
  it.each([
    ['the agent is still starting', false, false],
    ['no registry answers for the agent', true, false],
  ] as const)('keeps the menu it has when %s', (_label, hasAgent, hasCommands) => {
    const h = fixture()
    const sentinel = {} as CombinedAutocompleteProvider
    h.seedProvider(sentinel)
    h.state.agent = hasAgent ? ({} as Agent) : undefined
    h.state.commands = hasCommands ? COMMANDS : undefined
    h.input.installCompletion()
    h.input.applyCompletion()
    expect(h.editor.providers).toEqual([])
    expect(h.editor.getExpandedText()).toBe('')
    expect(h.latestProvider()).toBe(sentinel)
  })

  it('offers the commands this session can run at the tip', async () => {
    const h = installed()
    expect(h.editor.providers).toHaveLength(1)
    expect(await h.suggestions('/compact')).toContain('compact')
  })

  it('answers a question from the answer menu while the bar is borrowed', async () => {
    const h = installed()
    const atTip = h.latestProvider()
    h.bar.borrow(() => {
      h.input.applyCompletion()
    })
    const borrowed = h.latestProvider()
    expect(borrowed).not.toBe(atTip)
    expect(await h.suggestions('/compact')).not.toContain('compact')
  })

  it('keeps the answer menu when a command registers while a question is open', async () => {
    const h = installed()
    h.bar.borrow(() => {
      h.state.commands = [...COMMANDS, { name: 'brand-new', description: 'registered while open' }]
      h.input.installCompletion()
    })
    // A rebuild while the bar is borrowed must not put the prompt's command menu
    // back on a question, which would let a slash line be answered with a command.
    expect(await h.suggestions('/brand-new')).not.toContain('brand-new')
    expect(await h.suggestions('/compact')).not.toContain('compact')
  })

  it('gives the held prompt and the prompt menu back when the question closes', async () => {
    const h = installed()
    h.editor.text = 'kept draft'
    h.bar.borrow(() => {
      h.input.applyCompletion()
    })
    expect(h.editor.text).toBe('')
    h.bar.giveBack()
    h.input.applyCompletion()
    expect(h.editor.text).toBe('kept draft')
    expect(await h.suggestions('/compact')).toContain('compact')

    // A second give-back has no holder to return: it must not clear the draft the
    // reader has back, nor re-role the menu.
    const back = h.latestProvider()
    h.bar.giveBack()
    h.input.applyCompletion()
    expect(h.editor.text).toBe('kept draft')
    expect(h.latestProvider()).toBe(back)
  })

  it('rebuilds the menu when the registry reports a change', async () => {
    const h = fixture()
    h.state.agent = {} as Agent
    h.state.commands = COMMANDS
    h.input.installCompletion()
    const listeners = h.input.commandListeners()
    expect([...h.rec.handlers.keys()]).toEqual(['commands/change'])
    expect(listeners).toHaveLength(1)

    h.state.commands = [{ name: 'brand-new', description: 'registered later' }]
    h.rec.handlers.get('commands/change')?.()
    expect(await h.suggestions('/brand-new')).toContain('brand-new')

    // The registration's own disposer is what the surface pushes onto its list.
    listeners[0]?.()
    expect(h.rec.disposers).toBe(1)
  })
})

describe('the keys and the submit line', () => {
  it("installs the reader's keys where the library reads them", () => {
    const h = fixture()
    h.state.keymap = resolveKeymap({ 'prompt.submit': 'ctrl+g' })
    h.input.installBindings()
    expect(getKeybindings().getKeys('tui.input.submit')).toEqual(['ctrl+g'])
  })

  it('classifies one line, remembers it, and hands it over', () => {
    const h = fixture()
    h.input.attachSubmit()
    expect(h.editor.onSubmit).toBeTypeOf('function')
    h.editor.onSubmit?.('  hello world  ')
    expect(h.editor.history).toEqual(['  hello world  '])
    expect(h.rec.recorded).toEqual(['  hello world  '])
    expect(h.rec.runs).toEqual([{ kind: 'prompt', text: 'hello world' }])
  })

  it('ignores a line that is only whitespace', () => {
    const h = fixture()
    h.input.attachSubmit()
    h.editor.onSubmit?.('   ')
    expect(h.editor.history).toEqual([])
    expect(h.rec.recorded).toEqual([])
    expect(h.rec.runs).toEqual([])
  })

  it('routes a slash line as the command it is', () => {
    const h = fixture()
    h.input.attachSubmit()
    h.editor.onSubmit?.('/undo')
    expect(h.rec.runs).toEqual([{ kind: 'undo' }])
  })
})
