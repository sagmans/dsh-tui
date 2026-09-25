/**
 * The transcript owner: which session is on screen, what a fold, a replay and a
 * durable event put there, and which failures reach the reader as a notice.
 */

import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ForkEvent } from '@/agent/fork.ts'
import { defaultKeymap, type Keymap } from '@/input/actions.ts'
import { backHint, createSessionView, type SessionView, type SessionViewPorts } from '@/surface/session-view.ts'

const DRIVEN = 'tui-session-driven' as SessionId
const CHILD = 'tui-session-child' as SessionId
const STORED = 'tui-session-stored' as SessionId

/** Where undo's staged cursor stops the fold of the session being driven. */
const CUT = 3

/** A prompt the fold turns into a row the reader can be shown to see. */
const userEvent = (seq: number, text: string): ForkEvent => ({
  type: 'user/message',
  seq,
  data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
})

/** One read a test can hold open, so a newer view can be made to race it. */
function deferred<T>(): { readonly promise: Promise<T>; readonly settle: (value: T) => void; readonly reject: (error: unknown) => void } {
  let settle!: (value: T) => void
  let refuse!: (error: unknown) => void
  const promise = new Promise<T>((resolve, reject) => {
    settle = resolve
    refuse = reject
  })
  return { promise, settle, reject: error => refuse(error) }
}

/** Everything the transcript reads in the surface around it, recorded. */
interface Fixture {
  readonly view: SessionView
  /** The scope every port re-read answers with, which a card then reads its tool through. */
  readonly scope: Agent
  /** The scope a caller handed in directly, which no fold may keep using. */
  readonly handed: Agent
  readonly renders: () => number
  readonly scopesRead: SessionId[]
  /** Events of the sessions this process runs, keyed by id. */
  readonly live: Map<string, readonly ForkEvent[]>
  /** Logs the fake storage answers with, keyed by id. */
  readonly stored: Map<string, () => Promise<readonly ForkEvent[]>>
  readonly opened: string[]
  readonly closed: string[]
  readonly toolLookups: { readonly name: string; readonly scope: unknown }[]
  readonly listeners: Map<string, (payload: never) => void>
  readonly drive: (id: SessionId) => void
  readonly cutoff: (seq: number | undefined) => void
}

function fixture(options: { readonly persistence?: boolean } = {}): Fixture {
  const stored = new Map<string, () => Promise<readonly ForkEvent[]>>()
  const opened: string[] = []
  const closed: string[] = []
  const listeners = new Map<string, (payload: never) => void>()
  const toolLookups: { readonly name: string; readonly scope: unknown }[] = []
  const service = {
    list: async () => [],
    open: async (id: string) => {
      opened.push(id)
      return {
        read: async () => ({ events: await (stored.get(id) ?? (async () => []))() }),
        close: async () => {
          closed.push(id)
        },
      }
    },
  }
  const ctx = {
    get: (name: string) => (options.persistence === false || name !== 'sessionPersistence' ? undefined : service),
    on: (event: string, handler: (payload: never) => void) => {
      listeners.set(event, handler)
      return () => {}
    },
    // A tool no package declares: the row degrades, and the scope the lookup was
    // made through is what this spec is reading.
    tools: {
      get: (name: string, scope: unknown) => {
        toolLookups.push({ name, scope })
        return undefined
      },
    },
  } as unknown as Context
  const live = new Map<string, readonly ForkEvent[]>()
  const scopesRead: SessionId[] = []
  const scope = {} as Agent
  const handed = {} as Agent
  let driven: SessionId = DRIVEN
  let cut: number | undefined
  let renders = 0
  const ports: SessionViewPorts = {
    initialSession: DRIVEN,
    drivenSession: () => driven,
    stagedCutoff: () => cut,
    agentScope: id => {
      scopesRead.push(id)
      return scope
    },
    liveEvents: id => live.get(id),
    render: () => {
      renders += 1
    },
  }
  return {
    view: createSessionView(ctx, ports),
    scope,
    handed,
    renders: () => renders,
    scopesRead,
    live,
    stored,
    opened,
    closed,
    toolLookups,
    listeners,
    drive: id => {
      driven = id
    },
    cutoff: seq => {
      cut = seq
    },
  }
}

describe('createSessionView', () => {
  it('opens the transcript on the session the run named, and can be moved', () => {
    const given = fixture()

    expect(given.view.viewed()).toBe(DRIVEN)
    expect(given.view.viewingChild()).toBe(false)

    given.view.setViewed(CHILD)

    // The driven session does not change when the reader moves: the identity the
    // commands act on and the one on screen are two questions.
    expect(given.view.viewed()).toBe(CHILD)
    expect(given.view.viewingChild()).toBe(true)
  })

  it('marks a move to another session and a return to the one this terminal drives', async () => {
    const given = fixture()

    await given.view.show(CHILD)
    expect(given.view.model.entries()).toEqual([{ kind: 'marker', text: `viewing ${CHILD}` }])

    await given.view.showDriven()

    // A reader who left and came back has to be told which of the two they are
    // reading: both screens hold another session's words, and the previous
    // transcript is gone by the time the marker is written.
    expect(given.view.model.entries()).toEqual([
      { kind: 'marker', text: 'back to the session this terminal drives' },
    ])
    expect(given.view.viewingChild()).toBe(false)
  })

  it('folds a stored session through storage and always closes the handle it opened', async () => {
    const given = fixture()
    given.stored.set(CHILD, async () => [userEvent(1, 'hello')])

    await given.view.show(CHILD)

    expect(given.view.model.entries()).toEqual([
      { kind: 'user', text: 'hello' },
      { kind: 'marker', text: `viewing ${CHILD}` },
    ])
    // An unclosed handle keeps backend resources alive for the rest of the process.
    expect(given.opened).toEqual([CHILD])
    expect(given.closed).toEqual([CHILD])
  })

  it('folds a session this process runs from memory rather than from storage', async () => {
    const given = fixture()
    given.live.set(CHILD, [userEvent(1, 'from memory')])

    await given.view.show(CHILD)

    // Only memory holds the events that are not flushed yet.
    expect(given.view.model.entries()).toEqual([
      { kind: 'user', text: 'from memory' },
      { kind: 'marker', text: `viewing ${CHILD}` },
    ])
    expect(given.opened).toEqual([])
  })

  it('reports a read that failed instead of throwing it through the open', async () => {
    const given = fixture()
    given.stored.set(CHILD, async () => {
      throw new Error('log is unreadable')
    })

    await expect(given.view.show(CHILD)).resolves.toBeUndefined()

    expect(given.view.model.entries()).toEqual([
      { kind: 'notice', text: 'could not read that session: log is unreadable' },
      { kind: 'marker', text: `viewing ${CHILD}` },
    ])
    expect(given.closed).toEqual([CHILD])

    given.stored.set(CHILD, async () => {
      throw 'the log handle is gone'
    })
    await given.view.show(CHILD)

    // A failure the profile threw as a plain string still has to name itself,
    // and it lands before the marker that names the session on screen.
    expect(given.view.model.entries().slice(-2)).toEqual([
      { kind: 'notice', text: 'could not read that session: the log handle is gone' },
      { kind: 'marker', text: `viewing ${CHILD}` },
    ])
  })

  it('lets no read a newer view revoked paint into the transcript', async () => {
    const given = fixture()
    const slow = deferred<readonly ForkEvent[]>()
    given.stored.set(CHILD, () => slow.promise)
    given.stored.set(DRIVEN, async () => [])

    const leaving = given.view.show(CHILD)
    await given.view.showDriven()
    slow.settle([userEvent(1, 'too late')])
    await leaving

    // The reader already moved on: the late log would otherwise print one
    // session's words as another's, and nothing would correct it.
    expect(given.view.model.entries()).toEqual([
      { kind: 'marker', text: 'back to the session this terminal drives' },
    ])
  })

  it('replays a stored log and says how much of it the reader got', async () => {
    const given = fixture()
    given.stored.set(STORED, async () => [userEvent(1, 'one'), userEvent(2, 'two')])

    await given.view.replay(STORED)
    expect(given.view.model.entries()).toEqual([
      { kind: 'user', text: 'one' },
      { kind: 'user', text: 'two' },
      { kind: 'notice', text: 'replayed 2 events from the stored log' },
    ])

    await given.view.replay(DRIVEN)

    // A session with nothing stored is not news: a "replayed 0 events" line
    // would read as a failure of the resume that just worked.
    expect(given.view.model.entries()).toHaveLength(3)
  })

  it('reports a replay that failed rather than rejecting the resume', async () => {
    const given = fixture()
    given.stored.set(STORED, async () => {
      throw new Error('checksum mismatch')
    })

    await expect(given.view.replay(STORED)).resolves.toBeUndefined()

    expect(given.view.model.entries()).toEqual([
      { kind: 'notice', text: 'could not replay this session: checksum mismatch' },
    ])

    given.stored.set(STORED, async () => {
      throw 'the reader was told nothing'
    })
    await given.view.replay(STORED)

    // A failure the profile threw as a plain string still has to name itself.
    expect(given.view.model.entries().at(-1)).toEqual({
      kind: 'notice',
      text: 'could not replay this session: the reader was told nothing',
    })
  })

  it('hides the staged suffix only for the session this terminal drives', async () => {
    const given = fixture()
    given.cutoff(CUT)
    given.drive(DRIVEN)
    const log = [userEvent(1, 'kept'), userEvent(2, 'kept too'), userEvent(CUT, 'hidden'), userEvent(CUT + 1, 'hidden too')]

    given.live.set(DRIVEN, log)
    await given.view.fold(DRIVEN)
    expect(given.view.model.entries()).toEqual([
      { kind: 'user', text: 'kept' },
      { kind: 'user', text: 'kept too' },
    ])

    given.view.reset()
    given.live.set(CHILD, log)
    await given.view.fold(CHILD)
    // Undo hides turns of the agent this terminal drives; another session's
    // screen has no cursor, and its own suffix is not this reader's to hide.
    expect(given.view.model.entries()).toHaveLength(4)

    given.view.reset()
    given.stored.set(STORED, async () => log)
    await given.view.fold(STORED, CUT)
    // A stored log has no staged cursor either: the cut is taken from the agent
    // being driven, and the fold reads the file it was asked for.
    expect(given.view.model.entries()).toHaveLength(4)
  })

  it('folds a live session only through the cut a hidden turn set', async () => {
    const given = fixture()
    given.live.set(DRIVEN, [userEvent(1, 'one'), userEvent(2, 'two'), userEvent(3, 'hidden'), userEvent(4, 'hidden too')])

    given.view.reset()
    const folded = await given.view.fold(DRIVEN, 2)

    // Undo hides a turn by folding the log through its own cursor, so the
    // transcript must stop where the cursor says rather than at the log's end.
    expect(folded).toBe(2)
    expect(given.view.model.entries()).toEqual([
      { kind: 'user', text: 'one' },
      { kind: 'user', text: 'two' },
    ])
  })

  it('says nothing about a read that failed after the reader already left it', async () => {
    const given = fixture()
    const slow = deferred<readonly ForkEvent[]>()
    given.stored.set(CHILD, () => slow.promise)
    given.stored.set(DRIVEN, async () => [])

    const leaving = given.view.show(CHILD)
    await given.view.showDriven()
    slow.reject(new Error('the log was truncated'))
    await leaving

    // The reader is on another session: a failure of the one they left is not
    // their problem, and a notice would read as the session they are on failing.
    expect(given.view.model.entries()).toEqual([
      { kind: 'marker', text: 'back to the session this terminal drives' },
    ])
  })

  it('folds the same durable event once, and reads a whole log again after a reset', async () => {
    const given = fixture()
    given.live.set(DRIVEN, [userEvent(1, 'one')])

    await given.view.fold(DRIVEN)
    given.view.observe(DRIVEN, userEvent(1, 'one'))

    // A resumed session is folded while its loop is live, so the same event
    // arrives twice: the durable sequence is what keeps it from printing twice.
    expect(given.view.model.entries()).toEqual([{ kind: 'user', text: 'one' }])

    given.view.observe(DRIVEN, userEvent(2, 'two'))
    expect(given.view.model.entries()).toHaveLength(2)

    given.view.reset()
    given.live.set(DRIVEN, [userEvent(1, 'one'), userEvent(2, 'two')])
    await given.view.fold(DRIVEN)
    // A fold after a reset re-reads from the session's first event, or a reload
    // opening on a cleared screen would drop everything the cursor already knew.
    expect(given.view.model.entries()).toHaveLength(2)
  })

  it('drops an event of a session that is not on screen, without a repaint', () => {
    const given = fixture()

    given.view.observe(CHILD, userEvent(1, 'elsewhere'))

    expect(given.view.model.entries()).toEqual([])
    expect(given.renders()).toBe(0)
  })

  it('repaints for an event of the session on screen and reads that session scope', () => {
    const given = fixture()

    given.view.observe(DRIVEN, userEvent(1, 'mine'))

    expect(given.view.model.entries()).toEqual([{ kind: 'user', text: 'mine' }])
    expect(given.renders()).toBe(1)
    // A card folded now reads the world its own session mounted, not the one the
    // previous session left behind.
    expect(given.scopesRead).toEqual([DRIVEN])
  })

  it('reads the scope for the session being folded rather than the one it was handed', async () => {
    const given = fixture()
    given.live.set(DRIVEN, [
      { type: 'tool/call', seq: 1, data: { name: 'bash', arguments: '{"command":"ls"}', callId: 'c1' } },
    ])

    given.view.setPresentScope(given.handed)
    given.view.clearPresentScope()
    await given.view.fold(DRIVEN)

    // The scope is read at fold time because it can change between two folds; a
    // captured copy would resolve the tool against a world that no longer exists
    // and degrade the card to a bare generic row.
    expect(given.toolLookups).toEqual([{ name: 'bash', scope: given.scope }])
  })

  it('clears the transcript and the work fold, and revokes the reads started before it', async () => {
    const given = fixture()
    given.live.set(DRIVEN, [
      userEvent(1, 'one'),
      { type: 'todo/write', seq: 2, data: { todos: [{ content: 'ship it', status: 'in_progress' }] } },
    ])
    await given.view.fold(DRIVEN)
    expect(given.view.workState().todos).toHaveLength(1)

    const current = given.view.reset()
    expect(current()).toBe(true)
    expect(given.view.model.entries()).toEqual([])
    // The dock is a second fold of the same session, so a reset that left it
    // standing would show one session's plan over another's conversation.
    expect(given.view.workState()).toEqual({ planMode: false, todos: undefined, goal: undefined })

    given.view.reset()
    expect(current()).toBe(false)
  })

  it('reports a failure of the session on screen and ignores another session failure', () => {
    const given = fixture()
    for (const register of given.view.agentListeners()) expect(typeof register).toBe('function')

    expect([...given.listeners.keys()]).toEqual(['agent/error', 'agent/assistant-stream'])

    given.listeners.get('agent/error')?.({ agent: { id: CHILD }, error: new Error('boom') } as never)
    expect(given.view.model.entries()).toEqual([])
    expect(given.renders()).toBe(0)

    given.listeners.get('agent/error')?.({ agent: { id: DRIVEN }, error: new Error('boom') } as never)
    expect(given.view.model.entries()).toEqual([{ kind: 'notice', text: 'error: boom' }])
    expect(given.renders()).toBe(1)
  })

  it('appends a streamed answer only for the session on screen and only from a chunk frame', () => {
    const given = fixture()
    given.view.agentListeners()
    const stream = given.listeners.get('agent/assistant-stream')

    stream?.({ agent: { id: CHILD }, frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'not mine' } } } as never)
    stream?.({ agent: { id: DRIVEN }, frame: { type: 'message' } } as never)
    // A live delta folded into the wrong model prints one session's words as
    // another's, and the durable copy that follows never corrects it.
    expect(given.view.model.entries()).toEqual([])
    expect(given.renders()).toBe(0)

    stream?.({ agent: { id: DRIVEN }, frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'mine' } } } as never)
    expect(given.view.model.entries()).toEqual([{ kind: 'assistant', text: 'mine' }])
    expect(given.renders()).toBe(1)
  })

  it('answers a session events from memory while this process runs it, and from storage otherwise', async () => {
    const given = fixture()
    const memory = [userEvent(1, 'live')]
    // The stored read carries events to the fold, and a durable sequence is the
    // stream's own bookkeeping: a log read back has none of it.
    const fromDisk = [{ type: 'user/message', data: userEvent(2, 'stored').data }]
    given.live.set(DRIVEN, memory)
    given.stored.set(STORED, async () => fromDisk)

    await expect(given.view.sessionEvents(DRIVEN)).resolves.toBe(memory)
    await expect(given.view.sessionEvents(STORED)).resolves.toEqual(fromDisk)
    expect(given.opened).toEqual([STORED])
  })

  it('answers no events at all for a session this profile cannot reach', async () => {
    const given = fixture({ persistence: false })

    // A composition without durable storage still has to answer: a fork or an
    // undo reads every event before it decides anything.
    await expect(given.view.sessionEvents(STORED)).resolves.toEqual([])
    await expect(given.view.fold(STORED)).resolves.toBe(0)
    expect(given.view.model.entries()).toEqual([])
  })

  it('appends a notice, a marker and a failure to the transcript the session folds into', () => {
    const given = fixture()

    given.view.notice('this profile has no stash service')
    given.view.marker('preset → plan')
    given.view.reportError(new Error('render failed'))
    given.view.reportError('a string nobody threw as an Error')

    // The model is the one screen the reader reads, so a command's refusal and
    // the agent's failure land where the conversation already is, and a thrown
    // string still has to be readable rather than printing as an empty notice.
    expect(given.view.model.entries()).toEqual([
      { kind: 'notice', text: 'this profile has no stash service' },
      { kind: 'marker', text: 'preset → plan' },
      { kind: 'notice', text: 'error: render failed' },
      { kind: 'notice', text: 'error: agent failed' },
    ])
  })

  it('names the key the reader bound for leaving a view they did not open', () => {
    expect(backHint(defaultKeymap())).toBe('ctrl+b returns to this session')

    // The hint reads the live map, because a hint drawn after a settings edit
    // must not keep advertising the key the reader just moved.
    const rebound: Keymap = { effective: { 'surface.back': ['escape'] }, written: new Set(['surface.back']) }
    expect(backHint(rebound)).toBe('esc returns to this session')
  })
})
