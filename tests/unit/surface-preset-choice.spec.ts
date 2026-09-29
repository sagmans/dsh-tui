import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ForkInheritance, TuiAgent } from '@/agent/host.ts'
import type { PresetRoster, PresetSummary } from '@/agent/presets.ts'
import { defaultKeymap } from '@/input/actions.ts'
import { createPresetChoice, type PresetChoicePorts } from '@/surface/preset-choice.ts'
import type { Picker } from '@/surface/modal-input.ts'

const SESSION = 'tui-session-1' as SessionId
const PARENT = 'tui-session-0' as SessionId
/** The mode a session the reader branched from is running. */
const PARENT_MODE = 'ptc'
/** The roster's fallback when nobody named a mode. */
const ROSTER_DEFAULT = 'minimal'
/**
 * The glosses the picker paints for the shipped modes this spec names.
 *
 * Copied here because the roster's own table is not a public export, and a row
 * whose description changed would read as a mode the reader cannot recognise.
 */
const GLOSS: Readonly<Record<string, string>> = {
  standard: 'the agent this profile composes, its tools called directly',
  [PARENT_MODE]: 'the same agent, with its tools reached through one TypeScript program',
  [ROSTER_DEFAULT]: 'the same agent, as this profile composes it',
}

const MODES: readonly PresetSummary[] = [
  { id: 'standard', trust: 'system', name: undefined, description: undefined, broken: undefined },
  { id: PARENT_MODE, trust: 'system', name: 'PTC', description: undefined, broken: undefined },
  { id: ROSTER_DEFAULT, trust: 'system', name: undefined, description: undefined, broken: undefined },
]

/** The roster as the surface reads it, with every read it takes recorded. */
interface FakeRoster extends PresetRoster {
  readonly listed: () => number
  readonly resolved: string[]
  readonly selected: string[]
  /** The modes this roster no longer offers, which is what a stored mode can fall out of. */
  readonly gone: Set<string>
  defaultId: string
  /** The mode the session projection reports, which is what the refusal names. */
  running: string | undefined
  /** Whether a turn has run, which is what fixes the mode. */
  hasStarted: boolean
  failSelect: Error | undefined
  /** What the switch answers, which is the id the seat keeps. */
  answer: string | undefined
  /**
   * How many reads the roster answers with nothing before it holds a mode.
   *
   * A mode registers from its own row's apply, which the composition schedules
   * beside the surface: this is the window a launch reads the roster in, and what
   * a launch has to wait out rather than mistake for a profile without modes.
   */
  emptyReads: number
}

function fakeRoster(): FakeRoster {
  let listCalls = 0
  const roster: FakeRoster = {
    defaultId: ROSTER_DEFAULT,
    listed: () => listCalls,
    resolved: [],
    selected: [],
    gone: new Set<string>(),
    running: undefined,
    hasStarted: false,
    failSelect: undefined,
    answer: undefined,
    emptyReads: 0,
    async list() {
      listCalls += 1
      if (listCalls <= roster.emptyReads) return []
      return MODES.filter(mode => !roster.gone.has(mode.id))
    },
    async resolve(id) {
      roster.resolved.push(String(id))
      // A mode is registered when its own row applies, so a roster that has not
      // listed anything yet cannot resolve anything either: this is the read that
      // makes a launch's wait observable rather than incidental.
      if (listCalls <= roster.emptyReads) {
        throw new Error(`agentPresets: the roster resolved "${id}" to nothing usable`)
      }
      const summary = MODES.find(mode => mode.id === id)
      if (summary === undefined || roster.gone.has(summary.id)) {
        throw new Error(`agentPresets: the roster resolved "${id}" to nothing usable`)
      }
      return summary
    },
    async mount() {},
    async select(_agent, id) {
      if (roster.failSelect !== undefined) throw roster.failSelect
      roster.selected.push(id)
      return roster.answer ?? id
    },
    current: () => roster.running,
    started: () => roster.hasStarted,
  }
  return roster
}

interface Given {
  readonly ports: PresetChoicePorts
  /** The agent every read of the driving port answers with, unless the queue says otherwise. */
  readonly agent: TuiAgent
  readonly choice: ReturnType<typeof createPresetChoice>
  readonly notices: string[]
  readonly renders: () => number
  readonly stored: { value: string | undefined }
  readonly live: { value: string | undefined }
  readonly storedAsked: string[]
  readonly returned: () => number
  readonly pickers: Picker[]
  /** What the open list settles on; undefined is the reader cancelling it. */
  readonly pick: { value: string | undefined }
  /** The agent the surface drives; a queued entry answers a later read of it instead. */
  readonly driving: { value: TuiAgent | undefined; queue: Array<TuiAgent | undefined> }
  readonly navigationFails: { value: Error | undefined }
}

function fixture(roster: FakeRoster | undefined, requestedPreset?: string): Given {
  const notices: string[] = []
  const stored = { value: undefined as string | undefined }
  const live = { value: undefined as string | undefined }
  const storedAsked: string[] = []
  const pick = { value: undefined as string | undefined }
  const driving = { value: undefined as TuiAgent | undefined, queue: [] as Array<TuiAgent | undefined> }
  const navigationFails = { value: undefined as Error | undefined }
  const pickers: Picker[] = []
  let renders = 0
  let returned = 0
  const agent = { agent: { session: SESSION } } as unknown as TuiAgent
  const ports: PresetChoicePorts = {
    agentPresets: roster,
    requestedPreset,
    storedPreset: async id => { storedAsked.push(String(id)); return stored.value },
    livePreset: () => live.value,
    drivingAgent: () => driving.queue.length === 0 ? driving.value : driving.queue.shift(),
    keymap: () => defaultKeymap(),
    openPicker: async picker => { pickers.push(picker); return pick.value },
    notice: message => { notices.push(message) },
    render: () => { renders += 1 },
    returnToDrivenSession: async () => {
      returned += 1
      if (navigationFails.value !== undefined) throw navigationFails.value
    },
  }
  driving.value = agent
  return {
    ports,
    agent,
    choice: createPresetChoice(ports),
    notices,
    renders: () => renders,
    stored,
    live,
    storedAsked,
    returned: () => returned,
    pickers,
    pick,
    driving,
    navigationFails,
  }
}

const forkOf = (from: SessionId): ForkInheritance => ({ from, events: [] })

describe('createPresetChoice presetFor', () => {
  it('has no mode to name when the profile carries no roster', async () => {
    const given = fixture(undefined, PARENT_MODE)

    // A composition that dropped the row still runs the surface; naming a mode
    // the roster never listed would start a session nobody can compose.
    await expect(given.choice.presetFor(SESSION, false, undefined)).resolves.toBeUndefined()
    expect(given.choice.currentSeat()).toBe(PARENT_MODE)
  })

  it('runs a branch in the mode its parent is running', async () => {
    const given = fixture(fakeRoster(), 'standard')

    given.live.value = PARENT_MODE
    await expect(given.choice.presetFor(SESSION, false, forkOf(PARENT))).resolves.toBe(PARENT_MODE)
    // A parent whose projection says nothing leaves the reader's own seat.
    given.live.value = undefined
    await expect(given.choice.presetFor(SESSION, false, forkOf(PARENT))).resolves.toBe('standard')
  })

  it('takes a fresh session in the reader seat, and follows a roster default that arrives later', async () => {
    const roster = fakeRoster()
    const given = fixture(roster)

    await expect(given.choice.presetFor(SESSION, false, undefined)).resolves.toBe(ROSTER_DEFAULT)
    // The settings document is read after this row applies, so a default captured
    // at construction would pin every later session to the mode the bundle shipped.
    roster.defaultId = 'standard'
    await expect(given.choice.presetFor(SESSION, false, undefined)).resolves.toBe('standard')
  })

  it('keeps the composition a stored session recorded', async () => {
    const given = fixture(fakeRoster())
    given.stored.value = PARENT_MODE

    await expect(given.choice.presetFor(SESSION, true, undefined)).resolves.toBe(PARENT_MODE)
    expect(given.storedAsked).toEqual([String(SESSION)])
  })

  it('takes an explicit mode for a stored session whose own mode is gone', async () => {
    const roster = fakeRoster()
    roster.gone.add(PARENT_MODE)
    const given = fixture(roster, 'standard')
    given.stored.value = PARENT_MODE

    // Naming one explicitly is the reader's only way forward, so that is the one
    // case an override is taken for a session that recorded its own composition.
    await expect(given.choice.presetFor(SESSION, true, undefined)).resolves.toBe('standard')
  })

  it('seats a resumed session that recorded no mode', async () => {
    const given = fixture(fakeRoster(), 'standard')

    // Every session written before modes existed recorded none, and the reader's
    // seat is where they continue from.
    await expect(given.choice.presetFor(SESSION, true, undefined)).resolves.toBe('standard')
    expect(given.storedAsked).toEqual([String(SESSION)])
  })

  it('refuses a stored mode nothing offers when no other was named', async () => {
    const roster = fakeRoster()
    roster.gone.add(PARENT_MODE)
    const given = fixture(roster)
    given.stored.value = PARENT_MODE

    // Starting in a composition the log recorded but the roster cannot mount
    // would leave logged tool calls the new composition cannot make.
    await expect(given.choice.presetFor(SESSION, true, undefined)).rejects.toThrow(
      `session ${SESSION} runs mode "${PARENT_MODE}", which this roster no longer offers; name another with --preset`,
    )
  })

  it('refuses a named mode that contradicts the one the session recorded', async () => {
    const given = fixture(fakeRoster(), 'standard')
    given.stored.value = PARENT_MODE

    await expect(given.choice.presetFor(SESSION, true, undefined)).rejects.toThrow(
      `session ${SESSION} runs mode "${PARENT_MODE}", so --preset standard does not apply; /preset standard switches it before its first turn`,
    )
  })
})

describe('createPresetChoice validateLaunch', () => {
  it('resolves the named mode and seats the run in it', async () => {
    const roster = fakeRoster()
    const given = fixture(roster, PARENT_MODE)

    await given.choice.validateLaunch({ sessionId: SESSION, resume: false, resumePicker: false })

    expect(roster.resolved).toEqual([PARENT_MODE])
    expect(given.choice.currentSeat()).toBe(PARENT_MODE)
  })

  it('answers a mode this roster does not offer before the screen is taken', async () => {
    const given = fixture(fakeRoster(), 'nope')

    // The alternate screen closes over whatever was painted on it, so a launch
    // that cannot run has to be answered while the launcher still owns the tty,
    // and the reader has to be told which modes they could have named instead.
    await expect(given.choice.validateLaunch({ sessionId: SESSION, resume: false, resumePicker: false }))
      .rejects.toThrow('mode "nope" is not one this profile offers · modes: standard · ptc · minimal')
  })

  it('seats a launch nobody named a mode for', async () => {
    const roster = fakeRoster()
    const given = fixture(roster)

    await given.choice.validateLaunch({ sessionId: SESSION, resume: false, resumePicker: false })

    expect(roster.resolved).toEqual([])
    expect(given.choice.currentSeat()).toBe(ROSTER_DEFAULT)
  })

  it('waits out a roster whose modes are still registering', async () => {
    vi.useFakeTimers()
    try {
      const roster = fakeRoster()
      // Two reads see nothing: a launch that resolved the name on the first would
      // refuse a mode this profile offers, which is the launch a mode row's own
      // apply races the surface for.
      roster.emptyReads = 2
      const given = fixture(roster, PARENT_MODE)

      const validated = given.choice.validateLaunch({ sessionId: SESSION, resume: false, resumePicker: false })
      await vi.advanceTimersByTimeAsync(100)
      await expect(validated).resolves.toBeUndefined()
      expect(given.choice.currentSeat()).toBe(PARENT_MODE)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a name no mode arrives for, rather than waiting forever', async () => {
    vi.useFakeTimers()
    try {
      const roster = fakeRoster()
      // A profile that really has no modes must still answer the reader, so the
      // wait is a window and not a promise that a mode is on its way.
      roster.emptyReads = Number.MAX_SAFE_INTEGER
      const given = fixture(roster, 'nope')

      let answered = false
      const validated = given.choice.validateLaunch({ sessionId: SESSION, resume: false, resumePicker: false })
        .catch((error: Error) => { answered = true; throw error })
      const settled = expect(validated).rejects.toThrow('mode "nope" is not one this profile offers · modes: none')
      // A reader waiting on modes that never arrive still holds its window before
      // it answers, so a launch that races the roster is not refused by a moment.
      await vi.advanceTimersByTimeAsync(1_000)
      expect(answered).toBe(false)
      await vi.advanceTimersByTimeAsync(2_000)
      await settled
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for the session picker before judging a stored mode', async () => {
    const given = fixture(fakeRoster(), 'standard')
    given.stored.value = PARENT_MODE

    // The mode a stored session recorded can only be compared with the run's own
    // flag once that pick lands, so nothing is read and nothing is refused yet.
    await expect(given.choice.validateLaunch({ sessionId: SESSION, resume: true, resumePicker: true })).resolves.toBeUndefined()
    expect(given.storedAsked).toEqual([])
    expect(given.choice.currentSeat()).toBe('standard')
  })
})

describe('createPresetChoice runPresetCommand', () => {
  it('says there is no mode to choose when the profile has no roster', () => {
    const given = fixture(undefined)

    given.choice.runPresetCommand('')

    expect(given.notices).toEqual(['this profile has no agent roster, so there is no mode to choose'])
    expect(given.renders()).toBe(1)
  })

  it('says the agent is still starting instead of opening a list it cannot switch', () => {
    const given = fixture(fakeRoster())
    given.driving.value = undefined

    given.choice.runPresetCommand('')

    expect(given.notices).toEqual(['the agent is still starting; try again in a moment'])
    expect(given.renders()).toBe(1)
    expect(given.pickers).toEqual([])
  })

  it.each([
    ['standard', 'this session runs "standard" and has already started, so its mode is fixed — /new starts a fresh session'],
    [undefined, 'this session runs a mode and has already started, so its mode is fixed — /new starts a fresh session'],
  ])('refuses to list modes once a turn has run, with %s as the current one', (currentMode, refusal) => {
    const roster = fakeRoster()
    roster.running = currentMode
    roster.hasStarted = true
    const given = fixture(roster)

    given.choice.runPresetCommand('')

    // The mode decides which tools exist at all, so the harness refuses the swap
    // after a turn: the surface explains that rather than opening a list whose
    // choice would be rejected.
    expect(given.notices).toEqual([refusal])
    expect(given.renders()).toBe(1)
    expect(given.pickers).toEqual([])
  })

  it('opens the list on an unstarted session and switches to what it settled on', async () => {
    const roster = fakeRoster()
    roster.running = 'standard'
    const given = fixture(roster, 'standard')
    given.pick.value = PARENT_MODE

    given.choice.runPresetCommand('')

    await vi.waitFor(() => { expect(roster.selected).toEqual([PARENT_MODE]) })
    const card = given.pickers[0]?.card()
    expect(card?.title).toBe('agent preset · 3 available')
    expect(card?.rows.map(row => [row.label, row.description, row.current])).toEqual([
      ['standard', GLOSS.standard, true],
      [PARENT_MODE, GLOSS[PARENT_MODE], false],
      [ROSTER_DEFAULT, GLOSS[ROSTER_DEFAULT], false],
    ])
    // The durable selection is folded as a marker on the session it belongs to,
    // so a reader watching a child has to come back to see it.
    expect(given.returned()).toBe(1)
    expect(given.choice.currentSeat()).toBe(PARENT_MODE)
  })

  it('leaves the seat alone when the list is cancelled', async () => {
    const roster = fakeRoster()
    const given = fixture(roster, 'standard')
    given.pick.value = undefined

    given.choice.runPresetCommand('')

    await vi.waitFor(() => { expect(given.pickers).toHaveLength(1) })
    await vi.waitFor(() => { expect(roster.listed()).toBe(1) })
    await Promise.resolve()
    expect(roster.selected).toEqual([])
    expect(given.choice.currentSeat()).toBe('standard')
  })

  it('switches to a mode named on the command line without opening a list', async () => {
    const roster = fakeRoster()
    const given = fixture(roster, 'standard')

    given.choice.runPresetCommand('  ptc  ')

    await vi.waitFor(() => { expect(given.renders()).toBe(1) })
    expect(roster.selected).toEqual(['ptc'])
    expect(given.pickers).toEqual([])
  })

  it.each([new Error('the harness refused the swap'), 'the harness refused the swap'])(
    'reports a mode that could not be switched and keeps the seat: %s',
    async failure => {
      const roster = fakeRoster()
      roster.failSelect = failure as Error
      const given = fixture(roster, 'standard')

      given.choice.runPresetCommand('ptc')

      // Whatever a rejected switch threw has to reach the reader as one line: the
      // key press has nowhere else to put it.
      await vi.waitFor(() => { expect(given.notices).toEqual(['could not switch the mode: the harness refused the swap']) })
      expect(given.choice.currentSeat()).toBe('standard')
      expect(given.renders()).toBe(1)
    },
  )

  it('reports a navigation that failed after the mode was already switched', async () => {
    const given = fixture(fakeRoster(), 'standard')
    given.navigationFails.value = new Error('the view refused to move')

    given.choice.runPresetCommand('ptc')

    // The switch landed and the seat moved with it, so the notice has to say
    // the mode changed and name only the return that failed; a message that
    // blames the switch would send the reader redoing what already took.
    await vi.waitFor(() => {
      expect(given.notices).toEqual(['the mode switched to "ptc", but the return to the driven session failed: the view refused to move'])
    })
    expect(given.choice.currentSeat()).toBe(PARENT_MODE)
    expect(given.renders()).toBe(1)
  })

  it('changes nothing when the agent went away between the check and the switch', async () => {
    const roster = fakeRoster()
    const given = fixture(roster, 'standard')
    given.driving.queue.push(given.agent, undefined)

    given.choice.runPresetCommand('ptc')

    await Promise.resolve()
    expect(roster.selected).toEqual([])
    expect(given.renders()).toBe(0)
  })
})
