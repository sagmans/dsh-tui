/**
 * The staged-turn policy at the boundary the composer calls: the cursor over the
 * log, the prompts parked behind it, and the branch a send takes while turns are
 * hidden.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ForkEvent } from '@/agent/fork.ts'
import type { ForkInheritance, TuiAgent } from '@/agent/host.ts'
import { UNDO_TURN_SETTLE_MS } from '@/agent/undo.ts'
import { createStagedTurns, type StagedTurnPorts, type StagedTurns } from '@/surface/staged-turns.ts'

const SESSION = SessionId('tui-session-a')
const OTHER_SESSION = SessionId('tui-session-b')
/** The name a replacement session is opened under, which a branch has to carry. */
const CHILD_PREFIX = 'tui-session-'

const prompt = (text: string, seq: number): ForkEvent => ({
  type: 'user/message',
  data: { content: [{ type: 'text', text }], source: { kind: 'user' } },
  seq,
})

/** One closed turn with a direct prompt, positioned after the events given. */
const turn = (n: number, prior: readonly ForkEvent[]): ForkEvent[] => [
  { type: 'turn/start', data: { turn: n }, seq: prior.length },
  prompt(`ask ${n}`, prior.length + 1),
  { type: 'assistant/message', data: {}, seq: prior.length + 2 },
  { type: 'turn/end', data: { turn: n }, seq: prior.length + 3 },
]

const TWO_TURNS: readonly ForkEvent[] = [...turn(1, []), ...turn(2, turn(1, []))]

interface State {
  events: readonly ForkEvent[]
  /** When set, every log read rejects, which is how a fold failure reaches a command. */
  failure: unknown
  /** When set, every log read parks until the test releases it. */
  held: (() => void)[] | undefined
  /** When set, opening the replacement session rejects. */
  openFailure: Error | undefined
  /** When set, every park rejects, which is how a full bank reaches undo. */
  parkFailure: unknown
  agent: TuiAgent | undefined
  queued: readonly string[]
  canPark: boolean
  turnRunning: boolean
  viewingChild: boolean
  session: SessionId
  draft: string
}

interface Recorder {
  readonly notices: string[]
  readonly trace: string[]
  readonly folds: (number | undefined)[]
  readonly read: SessionId[]
  readonly opened: { id: SessionId; resume: boolean; fork: ForkInheritance | undefined }[]
  readonly submissions: string[]
  readonly written: string[]
  resets: number
  renders: number
}

interface Harness {
  readonly staged: StagedTurns
  readonly state: State
  readonly rec: Recorder
  /** Put a recording agent in service, which is what a send submits to. */
  drive(): void
  /** Let a held log read through, once the test has set up the race it wants. */
  release(): void
}

function harness(events: readonly ForkEvent[] = []): Harness {
  const state: State = {
    events,
    failure: undefined,
    held: undefined,
    openFailure: undefined,
    parkFailure: undefined,
    agent: undefined,
    queued: [],
    canPark: true,
    turnRunning: false,
    viewingChild: false,
    session: SESSION,
    draft: '',
  }
  const rec: Recorder = { notices: [], trace: [], folds: [], read: [], opened: [], submissions: [], written: [], resets: 0, renders: 0 }

  const recordAgent = (sessionId: SessionId): TuiAgent => ({
    sessionId,
    agent: {} as unknown as Agent,
    submit: text => {
      rec.submissions.push(text)
      rec.trace.push(`submit:${text}`)
    },
    steer: () => {},
    interrupt: () => {
      rec.trace.push('interrupt')
    },
    dispose: async () => {},
  })

  const ports: StagedTurnPorts = {
    viewingChild: () => state.viewingChild,
    activeSession: () => state.session,
    sessionEvents: (id: SessionId) => {
      rec.read.push(id)
      if (state.failure !== undefined) return Promise.reject(state.failure)
      if (state.held !== undefined) {
        const held = state.held
        return new Promise(resolve => {
          held.push(() => resolve(state.events))
        })
      }
      return Promise.resolve(state.events)
    },
    resetTranscript: () => {
      rec.resets += 1
    },
    foldTranscript: async (_id, cutoff) => {
      rec.folds.push(cutoff)
    },
    drivingAgent: () => state.agent,
    disposeOutgoing: async () => {
      rec.trace.push('dispose')
    },
    openSession: async (id, resume, fork) => {
      if (state.openFailure !== undefined) throw state.openFailure
      rec.opened.push({ id, resume, fork })
      rec.trace.push('open')
      return recordAgent(id)
    },
    queuedPrompts: () => state.queued,
    canPark: () => state.canPark,
    parkPrompt: async (text: string) => {
      rec.trace.push(`park:${text}`)
      if (state.parkFailure !== undefined) throw state.parkFailure
    },
    turnRunning: () => state.turnRunning,
    draft: () => state.draft,
    writeDraft: (text: string) => {
      state.draft = text
      rec.written.push(text)
    },
    notice: message => {
      rec.notices.push(message)
    },
    render: () => {
      rec.renders += 1
    },
  }

  return {
    staged: createStagedTurns(ports),
    state,
    rec,
    drive: () => {
      state.agent = recordAgent(state.session)
    },
    release: () => {
      const held = state.held ?? []
      state.held = undefined
      for (const resume of held) resume()
    },
  }
}

/** Let a fire-and-forget command run out; everything it awaits is a microtask. */
const settle = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 0))
}

afterEach(() => {
  vi.useRealTimers()
})

describe("the cursor over the session's turns", () => {
  it('opens a fresh cursor and cut for the session it is handed', async () => {
    const h = harness(TWO_TURNS)
    h.staged.undo()
    await settle()
    expect(h.staged.cursor().hidden).toBe(1)
    expect(h.staged.stagedCutoff()).toBe(4)

    h.state.session = OTHER_SESSION
    h.state.events = []
    h.staged.sessionOpened(OTHER_SESSION)
    expect(h.staged.cursor()).toEqual({ sessionId: OTHER_SESSION, hidden: 0, lastRestored: '' })
    expect(h.staged.stagedCutoff()).toBeUndefined()

    // The next press counts the log of the session now driven, not the one the
    // cursor was stepped over.
    h.staged.undo()
    await settle()
    expect(h.rec.read.at(-1)).toBe(OTHER_SESSION)
    expect(h.rec.notices.at(-1)).toBe('nothing to undo')
  })

  it("hides the newest turn behind the oldest hidden turn's cut", async () => {
    const h = harness(TWO_TURNS)
    h.staged.undo()
    await settle()
    expect(h.rec.resets).toBe(1)
    expect(h.rec.folds).toEqual([4])
    expect(h.rec.written).toEqual(['ask 2'])
    expect(h.rec.notices).toEqual(['undo · 1 prompt hidden · prefix r redo'])
    expect(h.staged.stagedCutoff()).toBe(4)
  })

  it('reports nothing to undo on a log with no closed turn', async () => {
    const h = harness([{ type: 'turn/start', data: { turn: 1 }, seq: 0 }])
    h.staged.undo()
    await settle()
    expect(h.rec.notices).toEqual(['nothing to undo'])
    expect(h.rec.trace).toEqual([])
    expect(h.rec.folds).toEqual([])
    expect(h.rec.renders).toBe(1)
  })

  it.each([
    ['undo', 'undo works on the session this terminal drives · ctrl+b comes back'],
    ['redo', 'redo works on the session this terminal drives · ctrl+b comes back'],
  ] as const)('refuses %s while a child is on screen', async (command, notice) => {
    const h = harness(TWO_TURNS)
    h.state.viewingChild = true
    h.staged[command]()
    await settle()
    expect(h.rec.notices).toEqual([notice])
    expect(h.rec.read).toEqual([])
    expect(h.rec.folds).toEqual([])
    expect(h.staged.cursor().hidden).toBe(0)
  })

  it('parks the draft in the bar before hiding a turn', async () => {
    const h = harness(TWO_TURNS)
    h.state.draft = 'half-written'
    h.staged.undo()
    await settle()
    expect(h.rec.trace).toEqual(['park:half-written'])
    // The parking rides its own notice before the undo one, because the reader
    // has to learn their words were kept.
    expect(h.rec.notices).toEqual([
      'the draft in the bar was parked in the stash',
      'undo · 1 prompt hidden · prefix r redo',
    ])
    expect(h.rec.written).toEqual(['ask 2'])
  })

  it('refuses to hide a turn when the bar holds a draft and no bank exists', async () => {
    const h = harness(TWO_TURNS)
    h.state.draft = 'half-written'
    h.state.canPark = false
    h.staged.undo()
    await settle()
    expect(h.rec.notices).toEqual(['the bar holds a draft and there is no stash to park it in; undo cancelled'])
    expect(h.rec.trace).toEqual([])
    expect(h.rec.folds).toEqual([])
    expect(h.staged.cursor().hidden).toBe(0)
  })

  it('does not park the text it restored itself', async () => {
    const h = harness(TWO_TURNS)
    h.staged.undo()
    await settle()
    expect(h.state.draft).toBe('ask 2')

    // No bank is left, so a second press only proceeds because the bar holds
    // this owner's own text rather than a draft the reader typed.
    h.state.canPark = false
    h.staged.undo()
    await settle()
    expect(h.rec.written).toEqual(['ask 2', 'ask 1'])
    expect(h.rec.notices).toEqual([
      'undo · 1 prompt hidden · prefix r redo',
      'undo · 2 prompts hidden · prefix r redo',
    ])
    expect(h.staged.cursor().hidden).toBe(2)
  })

  it('ignores a second undo while the first is still reading the log', async () => {
    const h = harness(TWO_TURNS)
    h.state.held = []
    h.staged.undo()
    h.staged.undo()
    h.release()
    await settle()
    expect(h.rec.folds).toEqual([4])
    expect(h.rec.notices).toEqual(['undo · 1 prompt hidden · prefix r redo'])
  })

  it('stringifies a failure that is not an Error', async () => {
    const h = harness(TWO_TURNS)
    h.state.failure = 'links only'
    h.staged.undo()
    await settle()
    expect(h.rec.notices).toEqual(['undo failed: links only'])
  })

  it('reports a failed undo and accepts the next press', async () => {
    const h = harness(TWO_TURNS)
    h.state.failure = new Error('log unreadable')
    h.staged.undo()
    await settle()
    expect(h.rec.notices).toEqual(['undo failed: log unreadable'])

    h.state.failure = undefined
    h.staged.undo()
    await settle()
    expect(h.rec.written).toEqual(['ask 2'])
  })

  it('abandons the undo when the driven session changes while it reads the log', async () => {
    const h = harness(TWO_TURNS)
    h.state.held = []
    h.staged.undo()
    h.state.session = OTHER_SESSION
    h.staged.sessionOpened(OTHER_SESSION)
    h.release()
    await settle()
    expect(h.staged.cursor()).toEqual({ sessionId: OTHER_SESSION, hidden: 0, lastRestored: '' })
    expect(h.staged.stagedCutoff()).toBeUndefined()
    expect(h.rec.folds).toEqual([])
    expect(h.rec.written).toEqual([])
    expect(h.rec.notices).toEqual([])
  })
})

describe('the interrupt an undo settles', () => {
  it('stops the running turn and continues once it closes', async () => {
    const h = harness(TWO_TURNS)
    h.drive()
    h.state.turnRunning = true
    h.staged.undo()
    await settle()
    expect(h.rec.trace).toEqual(['interrupt'])
    expect(h.rec.notices).toEqual([])

    // The composer hears every turn/end, so the settle is delivered more than
    // once: only the first may continue the command.
    h.staged.turnSettled()
    h.staged.turnSettled()
    await settle()
    expect(h.rec.folds).toEqual([4])
    expect(h.rec.notices).toEqual(['undo · 1 prompt hidden · prefix r redo'])
  })

  it('reports nothing to undo when stopping a turn hid nothing new', async () => {
    const h = harness(turn(1, []))
    h.staged.undo()
    await settle()
    h.drive()
    h.state.turnRunning = true
    h.staged.undo()
    await settle()
    h.staged.turnSettled()
    await settle()
    expect(h.rec.notices.at(-1)).toBe('nothing to undo')
    expect(h.staged.cursor().hidden).toBe(1)
  })

  it('gives up on a turn that never closes, after the settle budget', async () => {
    vi.useFakeTimers()
    const h = harness(TWO_TURNS)
    h.drive()
    h.state.turnRunning = true
    h.staged.undo()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(UNDO_TURN_SETTLE_MS)
    expect(h.rec.notices).toEqual(['could not stop the turn; undo cancelled'])
    expect(h.rec.folds).toEqual([])
    expect(h.staged.cursor().hidden).toBe(0)
  })

  it('refuses the undo when queued prompts have no bank to park in', async () => {
    const h = harness(TWO_TURNS)
    h.drive()
    h.state.queued = ['waiting']
    h.state.canPark = false
    h.staged.undo()
    await settle()
    expect(h.rec.notices).toEqual(['queued prompts have no stash to park in; undo cancelled'])
    expect(h.rec.trace).toEqual([])
    expect(h.staged.cursor().hidden).toBe(0)
  })

  it('parks queued prompts newest first, before the interrupt that drops them', async () => {
    const h = harness(TWO_TURNS)
    h.drive()
    h.state.queued = ['first', 'second']
    h.staged.undo()
    await settle()
    // Cancelling the turn drops the queue, so every park must land first.
    expect(h.rec.trace).toEqual(['park:second', 'park:first', 'interrupt'])
    expect(h.rec.notices).toEqual(['undo · 1 prompt hidden · 2 queued prompts parked in the stash · prefix r redo'])
  })

  it('refuses the undo and keeps the turn running when a park fails', async () => {
    const h = harness(TWO_TURNS)
    h.drive()
    h.state.turnRunning = true
    h.state.queued = ['waiting']
    h.state.parkFailure = new Error('stash locked')
    h.staged.undo()
    await settle()
    expect(h.rec.notices).toEqual(['could not park the queued prompts; undo cancelled'])
    // No interrupt: cancelling would drop the very words that could not be parked.
    expect(h.rec.trace).toEqual(['park:waiting'])
    expect(h.state.queued).toEqual(['waiting'])
    expect(h.rec.folds).toEqual([])
    expect(h.staged.cursor().hidden).toBe(0)
  })

  it('names a single parked prompt in the singular', async () => {
    const h = harness(TWO_TURNS)
    h.drive()
    h.state.queued = ['only']
    h.staged.undo()
    await settle()
    expect(h.rec.notices).toEqual(['undo · 1 prompt hidden · 1 queued prompt parked in the stash · prefix r redo'])
  })

  it('abandons the undo when the driven session changes while it settles', async () => {
    const h = harness(TWO_TURNS)
    h.staged.undo()
    await settle()
    h.drive()
    h.state.turnRunning = true
    h.staged.undo()
    await settle()
    h.state.session = OTHER_SESSION
    h.staged.sessionOpened(OTHER_SESSION)
    h.staged.turnSettled()
    await settle()
    // The press belonged to the session it started in: none of its step may
    // land on the cursor, cut, or bar of the session now driven.
    expect(h.staged.cursor()).toEqual({ sessionId: OTHER_SESSION, hidden: 0, lastRestored: '' })
    expect(h.staged.stagedCutoff()).toBeUndefined()
    expect(h.rec.folds).toEqual([4])
    expect(h.rec.written).toEqual(['ask 2'])
    expect(h.rec.notices).toEqual(['undo · 1 prompt hidden · prefix r redo'])
  })
})

describe('the send a staged cursor branches', () => {
  it('submits in place while the cursor is at the tip', async () => {
    const h = harness(TWO_TURNS)
    h.drive()
    await h.staged.send('next')
    expect(h.rec.trace).toEqual(['submit:next'])
    expect(h.rec.submissions).toEqual(['next'])
    expect(h.rec.opened).toEqual([])
    expect(h.rec.notices).toEqual([])
  })

  it('refuses to send while no agent is in service', async () => {
    const h = harness(TWO_TURNS)
    await h.staged.send('next')
    expect(h.rec.notices).toEqual(['the agent is still starting; try again in a moment'])
    expect(h.rec.submissions).toEqual([])
  })

  it('branches from the visible prefix when turns are hidden', async () => {
    const h = harness(TWO_TURNS)
    h.staged.undo()
    await settle()
    h.drive()
    await h.staged.send('next')

    // Stopping the outgoing agent comes before the replacement opens: two
    // sessions must never be projected at once.
    expect(h.rec.trace).toEqual(['dispose', 'open', 'submit:next'])
    const opened = h.rec.opened.at(0)
    expect(String(opened?.id).startsWith(CHILD_PREFIX)).toBe(true)
    expect(opened?.id).not.toBe(SESSION)
    expect(opened?.resume).toBe(false)
    expect(opened?.fork).toEqual({ from: SESSION, events: TWO_TURNS.slice(0, 4) })
    expect(h.rec.notices.at(-1)).toBe(`continuing in a new branch · ${SESSION} keeps the undone turns`)
  })

  it('opens the branch with no inheritance when the visible prefix is empty', async () => {
    const h = harness(turn(1, []))
    h.staged.undo()
    await settle()
    h.drive()
    await h.staged.send('next')
    expect(h.rec.opened.at(0)?.fork).toBeUndefined()
    expect(h.rec.submissions).toEqual(['next'])
  })

  it('reports a branch that could not open and submits nothing', async () => {
    const h = harness(TWO_TURNS)
    h.staged.undo()
    await settle()
    h.drive()
    h.state.openFailure = new Error('no route')
    await h.staged.send('next')
    expect(h.rec.notices.at(-1)).toBe('could not send: no route')
    expect(h.rec.submissions).toEqual([])
    expect(h.rec.renders).toBeGreaterThan(0)
  })
})

describe('forward again after an undo', () => {
  it('steps forward and clears the composer at the tip', async () => {
    const h = harness(TWO_TURNS)
    h.staged.undo()
    await settle()
    h.staged.redo()
    await settle()
    expect(h.rec.written).toEqual(['ask 2', ''])
    expect(h.rec.folds).toEqual([4, undefined])
    expect(h.rec.notices.at(-1)).toBe('redo · back at the newest prompt')
    expect(h.staged.stagedCutoff()).toBeUndefined()
  })

  it('keeps a bar the reader edited while stepping forward', async () => {
    const h = harness(TWO_TURNS)
    h.staged.undo()
    await settle()
    h.state.draft = 'my own words'
    h.staged.redo()
    await settle()
    expect(h.rec.written).toEqual(['ask 2'])
    expect(h.rec.notices.at(-1)).toBe('redo · back at the newest prompt')
    expect(h.staged.cursor().hidden).toBe(0)
  })

  it('names the prompts still hidden when redo steps back into them', async () => {
    const h = harness(TWO_TURNS)
    h.staged.undo()
    await settle()
    h.staged.undo()
    await settle()
    h.staged.redo()
    await settle()
    expect(h.rec.notices.at(-1)).toBe('redo · 1 prompt hidden')
  })

  it('counts the prompts still hidden when more than one is left', async () => {
    const threeTurns = [...turn(1, []), ...turn(2, turn(1, [])), ...turn(3, turn(2, turn(1, [])))]
    const h = harness(threeTurns)
    h.staged.undo()
    await settle()
    h.staged.undo()
    await settle()
    h.staged.undo()
    await settle()
    h.staged.redo()
    await settle()
    expect(h.rec.notices.at(-1)).toBe('redo · 2 prompts hidden')
  })

  it('reports nothing to redo at the tip', async () => {
    const h = harness(TWO_TURNS)
    h.staged.redo()
    await settle()
    expect(h.rec.notices).toEqual(['nothing to redo'])
    expect(h.rec.folds).toEqual([])
  })

  it('reports a failed redo and leaves the cursor where it was', async () => {
    const h = harness(TWO_TURNS)
    h.staged.undo()
    await settle()
    h.state.failure = new Error('log gone')
    h.staged.redo()
    await settle()
    expect(h.rec.notices.at(-1)).toBe('redo failed: log gone')
    expect(h.staged.cursor().hidden).toBe(1)
  })

  it('ignores a redo pressed while an undo is still settling', async () => {
    const h = harness(TWO_TURNS)
    h.staged.undo()
    await settle()
    h.drive()
    h.state.turnRunning = true
    h.staged.undo()
    await settle()
    // A redo now would step the cursor the settling undo is about to replace.
    h.staged.redo()
    h.staged.turnSettled()
    await settle()
    expect(h.rec.notices).toEqual([
      'undo · 1 prompt hidden · prefix r redo',
      'undo · 2 prompts hidden · prefix r redo',
    ])
    expect(h.rec.written).toEqual(['ask 2', 'ask 1'])
    expect(h.rec.folds).toEqual([4, 0])

    // The refusal spans only the settle: afterwards redo answers again.
    h.staged.redo()
    await settle()
    expect(h.rec.notices.at(-1)).toBe('redo · 1 prompt hidden')
  })
})
