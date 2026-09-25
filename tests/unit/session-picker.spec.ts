/**
 * A bare `--resume` lists the stored sessions, names them behind the list, and
 * turns a choice into the id the run opens — or into the reason it cannot.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { PICKER_LIMIT, TITLE_EVENT_LIMIT } from '@/agent/history.ts'
import { defaultKeymap } from '@/input/actions.ts'
import { createSessionPicker, type SessionPickerChoice } from '@/surface/session-picker.ts'
import type { SessionPicker } from '@/ui/picker.ts'

/**
 * Titles the module reads at once.
 *
 * It is a bound rather than an answer, so the module keeps it private; what the
 * case below checks is the reader's guarantee — a hundred stored sessions must
 * not become a hundred log reads at once.
 */
const TITLE_CONCURRENCY = 4

const SESSION_A = 'session-a'
const SESSION_B = 'session-b'

interface ReadCall {
  readonly id: string
  readonly offset: number
  readonly limit: number | undefined
}

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

/** One snapshot in the shape the persistence seam lists. */
const stored = (id: string, createdAt: number, extra: { readonly cwd?: string; readonly eventCount?: number } = {}): unknown => ({
  header: { id, createdAt, ...(extra.cwd === undefined ? {} : { cwd: extra.cwd }) },
  ...(extra.eventCount === undefined ? {} : { eventCount: extra.eventCount }),
})

const titled = (title: string): unknown => ({ type: 'session/title', data: { title } })

interface Options {
  readonly snapshots?: readonly unknown[]
  readonly logs?: Record<string, readonly unknown[]>
  readonly listError?: unknown
  readonly readError?: ReadonlySet<string>
  /** A read the case answers by hand, to watch what is in flight. */
  readonly onRead?: (id: string) => Promise<readonly unknown[]>
  readonly validate?: (id: string) => Promise<void>
  readonly noService?: boolean
  readonly serviceWithoutList?: boolean
}

type Fixture = ReturnType<typeof fixture>

function fixture(options: Options = {}) {
  const notices: string[] = []
  let renders = 0
  const reads: ReadCall[] = []
  const snapshots = options.snapshots ?? []
  const logs = options.logs ?? {}
  let opened: SessionPicker | undefined
  let vet: ((id: string) => Promise<string | undefined>) | undefined
  let settlePick: ((id: string | undefined) => void) | undefined

  const service = options.noService === true
    ? undefined
    : options.serviceWithoutList === true
      ? { open: async () => ({ read: async () => ({ events: [] }), close: async () => {} }) }
      : {
          list: async (): Promise<unknown> => {
            if (options.listError !== undefined) throw options.listError
            return snapshots
          },
          open: async (id: string) => ({
            read: async (offset = 0, length?: number): Promise<{ events: readonly unknown[] }> => {
              reads.push({ id, offset, limit: length })
              if (options.readError?.has(id) === true) throw new Error('log is unreadable')
              if (options.onRead !== undefined) return { events: await options.onRead(id) }
              const events = logs[id] ?? []
              return { events: events.slice(offset, length === undefined ? undefined : offset + length) }
            },
            close: async () => {},
          }),
        }

  const ctx = { get: () => service } as unknown as Context
  const choice: SessionPickerChoice = createSessionPicker(ctx, {
    keymap: defaultKeymap,
    notice: text => {
      notices.push(text)
    },
    render: () => {
      renders += 1
    },
    validateStoredPreset: options.validate ?? (async () => {}),
    openPicker: (picker, given) => {
      opened = picker
      vet = given
      return new Promise<string | undefined>(resolve => {
        settlePick = resolve
      })
    },
  })
  return {
    choice,
    notices,
    reads,
    renderCount: () => renders,
    picker: () => opened,
    vet: () => vet,
    choose: (id: string | undefined) => settlePick?.(id),
  }
}

/** Wait for the list the surface opens before the run can pick from it. */
async function listOpens(given: Fixture): Promise<SessionPicker> {
  await vi.waitFor(() => {
    if (given.picker() === undefined) throw new Error('the picker was never opened')
  })
  return given.picker() as SessionPicker
}

describe('listing stored sessions', () => {
  it.each([
    { shape: 'no storage service at all', options: { noService: true } },
    { shape: 'a service that cannot list', options: { serviceWithoutList: true } },
  ])('says a profile without storage has nothing to resume ($shape)', async ({ options }) => {
    const given = fixture(options)

    // The list is the only thing this command could offer, and a composition
    // without durable storage still runs: ending the run here would turn an
    // absent optional service into a dead terminal.
    await expect(given.choice.chooseSession()).resolves.toBeUndefined()
    expect(given.notices).toEqual(['this profile has no session storage, so there is nothing to resume'])
    expect(given.picker()).toBeUndefined()
    expect(given.renderCount()).toBe(1)
  })

  it('says an empty history has nothing to resume', async () => {
    const given = fixture({ snapshots: [] })

    await expect(given.choice.chooseSession()).resolves.toBeUndefined()
    expect(given.notices).toEqual(['no stored sessions to resume'])
    expect(given.renderCount()).toBe(1)
  })

  it.each([
    { thrown: new Error('disk is on fire'), said: 'disk is on fire' },
    { thrown: 'offline', said: 'offline' },
  ])('reports why the listing failed instead of ending the run ($said)', async ({ thrown, said }) => {
    const given = fixture({ listError: thrown })

    // A storage the reader can repair must be named, not swallowed: the resume
    // key would otherwise look broken with no way to find out why.
    await expect(given.choice.chooseSession()).resolves.toBeUndefined()
    expect(given.notices).toEqual([`could not list stored sessions: ${said}`])
    expect(given.renderCount()).toBe(1)
  })

  it('offers no more rows than a menu can hold', async () => {
    const snapshots = Array.from({ length: PICKER_LIMIT + 1 }, (_value, index) => stored(`session-${index}`, index))
    const given = fixture({ snapshots })

    const choosing = given.choice.chooseSession()
    const picker = await listOpens(given)

    expect(picker.card().title).toBe(`resume a session · ${PICKER_LIMIT} stored`)
    given.choose(undefined)
    await expect(choosing).resolves.toBeUndefined()
  })
})

describe('rows before titles', () => {
  it('draws every session by id, with the little the listing knows', async () => {
    const now = Date.now()
    const given = fixture({
      snapshots: [
        stored(SESSION_B, now, { cwd: '/work/b', eventCount: 3 }),
        stored(SESSION_A, now + 1),
      ],
      logs: { [SESSION_B]: [], [SESSION_A]: [] },
    })

    const choosing = given.choice.chooseSession()
    const picker = await listOpens(given)

    // Reading every title first would make opening the list as slow as the
    // slowest log, and a session whose log this build cannot read is still one
    // the reader may want back — so the row exists before the name does.
    expect(picker.card().rows).toEqual([
      { label: SESSION_A, description: 'unknown directory · just now', current: true },
      { label: SESSION_B, description: '/work/b · just now · 3 events', current: false },
    ])

    given.choose(undefined)
    await expect(choosing).resolves.toBeUndefined()
  })

  it('renames a row with the title its log carries, repainting per title', async () => {
    const now = Date.now()
    const given = fixture({
      snapshots: [stored(SESSION_A, now), stored(SESSION_B, now - 1)],
      logs: { [SESSION_A]: [titled('fix the parser')], [SESSION_B]: [titled('dock polish')] },
    })

    const choosing = given.choice.chooseSession()
    const picker = await listOpens(given)
    await vi.waitFor(() => {
      if (picker.card().rows[0]?.label === SESSION_A) throw new Error('the titles have not landed')
    })

    expect(picker.card().rows.map(row => row.label)).toEqual(['fix the parser', 'dock polish'])
    // A title that lands has to reach the screen; the row it names is the one
    // the reader is deciding between.
    expect(given.renderCount()).toBe(2)

    given.choose(undefined)
    await expect(choosing).resolves.toBeUndefined()
  })

  it('reads a long log from its tail, so a late title is not missed', async () => {
    const events: unknown[] = Array.from({ length: 100 }, (_value, index) => ({ type: 'turn/start', data: { turn: index } }))
    events[90] = titled('the latest name')
    const given = fixture({ snapshots: [stored(SESSION_A, Date.now(), { eventCount: 100 })], logs: { [SESSION_A]: events } })

    const choosing = given.choice.chooseSession()
    const picker = await listOpens(given)
    await vi.waitFor(() => {
      if (picker.card().rows[0]?.label === SESSION_A) throw new Error('the title has not landed')
    })

    expect(picker.card().rows[0]?.label).toBe('the latest name')
    expect(given.reads).toEqual([{ id: SESSION_A, offset: 100 - TITLE_EVENT_LIMIT, limit: TITLE_EVENT_LIMIT }])

    given.choose(undefined)
    await expect(choosing).resolves.toBeUndefined()
  })

  it('leaves an unreadable or nameless log listed by id, and repaints the rest', async () => {
    const given = fixture({
      snapshots: [stored(SESSION_A, Date.now()), stored(SESSION_B, Date.now() - 1)],
      logs: { [SESSION_A]: [titled('named anyway')], [SESSION_B]: [{ type: 'turn/start', data: { turn: 1 } }] },
      readError: new Set([SESSION_B]),
    })

    const choosing = given.choice.chooseSession()
    const picker = await listOpens(given)
    // One bad log is not the list: the healthy session still gets its name.
    await vi.waitFor(() => {
      if (picker.card().rows[0]?.label !== 'named anyway') throw new Error('the healthy title has not landed')
    })
    await settle()

    expect(picker.card().rows.map(row => row.label)).toEqual(['named anyway', SESSION_B])
    expect(given.renderCount()).toBe(1)

    given.choose(undefined)
    await expect(choosing).resolves.toBeUndefined()
  })

  it('keeps the log reads bounded however many sessions are stored', async () => {
    const snapshots = Array.from({ length: TITLE_CONCURRENCY * 2 }, (_value, index) => stored(`session-${index}`, index))
    const started: string[] = []
    const waiting: (() => void)[] = []
    const admit = (): void => {
      waiting.shift()?.()
    }
    const given = fixture({
      snapshots,
      onRead: id => {
        started.push(id)
        return new Promise<readonly unknown[]>(resolve => {
          waiting.push(() => resolve([titled('later')]))
        })
      },
    })

    const choosing = given.choice.chooseSession()
    await listOpens(given)
    await vi.waitFor(() => {
      if (started.length !== TITLE_CONCURRENCY) throw new Error(`${started.length} reads are in flight`)
    })

    // A hundred parallel log reads is a disk storm the reader would feel in the
    // rest of the surface, so a finished read admits the next rather than the
    // whole list going out at once.
    admit()
    await vi.waitFor(() => {
      if (started.length !== TITLE_CONCURRENCY + 1) throw new Error('a finished read admitted no reader')
    })
    while (started.length < snapshots.length) {
      const before = started.length
      admit()
      await vi.waitFor(() => {
        if (started.length === before) throw new Error('a finished read admitted no reader')
      })
    }
    // The queue is empty now, so the admitted titles are the last work left.
    while (given.renderCount() < snapshots.length) {
      const before = given.renderCount()
      admit()
      await vi.waitFor(() => {
        if (given.renderCount() === before) throw new Error('a title never landed')
      })
    }

    given.choose(undefined)
    await expect(choosing).resolves.toBeUndefined()
  })
})

describe('what a choice means', () => {
  it('answers with the id the reader settled on', async () => {
    const given = fixture({ snapshots: [stored(SESSION_A, Date.now())], logs: { [SESSION_A]: [] } })

    const choosing = given.choice.chooseSession()
    const picker = await listOpens(given)
    const action = picker.handleKey('\r')
    expect(action).toEqual({ kind: 'pick', id: SESSION_A })
    given.choose(action?.kind === 'pick' ? action.id : undefined)

    await expect(choosing).resolves.toBe(SessionId(SESSION_A))
  })

  it('answers nothing when the reader leaves the list', async () => {
    const given = fixture({ snapshots: [stored(SESSION_A, Date.now())], logs: { [SESSION_A]: [] } })

    const choosing = given.choice.chooseSession()
    const picker = await listOpens(given)
    expect(picker.handleKey('\x1b')).toEqual({ kind: 'cancel' })
    given.choose(undefined)

    // Leaving is not a choice of session: the run has nothing to open, and only
    // the reader can say what they meant by it.
    await expect(choosing).resolves.toBeUndefined()
  })

  it('refuses a pick the run cannot open, naming why', async () => {
    const seen: string[] = []
    const given = fixture({
      snapshots: [stored(SESSION_A, Date.now())],
      logs: { [SESSION_A]: [] },
      validate: async id => {
        seen.push(id)
        throw new Error(`this run named --preset code; ${id} ran gemini`)
      },
    })

    const choosing = given.choice.chooseSession()
    await listOpens(given)
    const reason = await given.vet()?.(SESSION_A)

    // The refusal has to reach the list the reader is still looking at, rather
    // than land after the terminal has been handed back to the shell.
    expect(reason).toBe('this run named --preset code; session-a ran gemini')
    expect(seen).toEqual([SESSION_A])

    given.choose(undefined)
    await expect(choosing).resolves.toBeUndefined()
  })

  it.each([
    { thrown: new Error('mode mismatch'), said: 'mode mismatch' },
    { thrown: 'mode mismatch', said: 'mode mismatch' },
  ])('reports a refusal thrown without an Error as its own text ($said)', async ({ thrown, said }) => {
    const given = fixture({
      snapshots: [stored(SESSION_A, Date.now())],
      logs: { [SESSION_A]: [] },
      validate: async () => {
        throw thrown
      },
    })

    const choosing = given.choice.chooseSession()
    await listOpens(given)
    expect(await given.vet()?.(SESSION_A)).toBe(said)

    given.choose(undefined)
    await expect(choosing).resolves.toBeUndefined()
  })

  it('lets a pick through when the run can open it', async () => {
    const seen: string[] = []
    const given = fixture({
      snapshots: [stored(SESSION_A, Date.now())],
      logs: { [SESSION_A]: [] },
      validate: async id => {
        seen.push(id)
      },
    })

    const choosing = given.choice.chooseSession()
    await listOpens(given)
    expect(await given.vet()?.(SESSION_A)).toBeUndefined()
    expect(seen).toEqual([SESSION_A])

    given.choose(SESSION_A)
    await expect(choosing).resolves.toBe(SessionId(SESSION_A))
  })
})
