import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { PROFILE_NAME, resumeHint } from '@/identity.ts'
import { createTerminalLifecycle, type TerminalLifecycle, type TerminalLifecyclePorts } from '@/surface/terminal-lifecycle.ts'
import { clipboardSequence } from '@/terminal/clipboard.ts'
import { windowTitle } from '@/terminal/title.ts'
import { frameBlock, type FrameRow } from '@/ui/frame.ts'

const SESSION = 'tui-session-1' as SessionId
const FAILED_EXIT_STATUS = 1
const CONTROL_REASON = 'failed\x1b]0;title\x07\x1b[31mred\x1b[0m\rprefix\b\x9b2J'
const LITERAL_REASON = String.raw`failed\x1B]0;title\x07\x1B[31mred\x1B[0m\x0Dprefix\x08\x9B2J`
/** The status a shell reports a SIGTERM with; the surface leaves the way a supervisor expects. */
const SIGTERM_STATUS = 143
/** What the bar holds when the reader asks for their own editor. */
const DRAFT = 'a draft from the bar'
const EDITOR_GATE_POLL_MS = 10
/** The one sentence a run with no editor answers, so the reader is not left with a dead key. */
const NO_EDITOR = 'no editor configured: set $VISUAL or $EDITOR to open the draft in one'

const created: string[] = []
const teardowns: Array<() => void> = []

afterEach(() => {
  for (const teardown of teardowns.splice(0)) teardown()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * An editor the surface can really start, so the handoff is the one a reader gets.
 *
 * The child writes what it was asked to into the draft the surface handed it and
 * exits: nothing about the surface's own editor plumbing is stubbed, only the
 * program behind $VISUAL.
 */
function fakeEditor(write: string, gate?: { started: string; release: string }): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lifecycle-editor-'))
  created.push(dir)
  const script = join(dir, 'editor.mjs')
  const wait = gate === undefined ? '' : `writeFileSync(${JSON.stringify(gate.started)}, '')
while (!existsSync(${JSON.stringify(gate.release)})) await new Promise(resolve => setTimeout(resolve, ${EDITOR_GATE_POLL_MS}))
`
  writeFileSync(script, `import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
${wait}appendFileSync(process.argv[2], ${JSON.stringify(write)})
`)
  return `${process.execPath} ${script}`
}

/**
 * The library dispatches stdin through a private method and registers nothing
 * public for it, so the terminal's own input path is reached here the one way it
 * is reachable; the surface routes every key and mouse report through it.
 */
function sendInput(tui: TerminalLifecycle['tui'], data: string): void {
  (tui as unknown as { handleTerminalInput(data: string): void }).handleTerminalInput(data)
}

interface Fixture {
  readonly lifecycle: TerminalLifecycle
  /** One call for one Cordis effect registration; the answer is the module's teardown. */
  readonly unload: () => void
  readonly notices: string[]
  readonly frameErrors: unknown[]
  readonly exits: number[]
  readonly stops: () => number
  readonly written: string[]
  readonly held: string[]
  readonly rows: { value: readonly FrameRow[] }
  readonly reads: () => number
  readonly sessionOpened: { value: boolean }
  readonly turnRunning: { value: boolean }
  readonly draftBorrowed: { value: boolean }
  /** Everything written to the terminal through the spied instance. */
  readonly writes: string[]
}

function fixture(): Fixture {
  let teardown = (): void => {}
  const ctx = {
    // Cordis runs the callback as it registers it and disposes whatever it answered.
    effect: (callback: () => () => void) => { teardown = callback() },
  } as unknown as Context
  const notices: string[] = []
  const frameErrors: unknown[] = []
  const exits: number[] = []
  const written: string[] = []
  const held: string[] = []
  const rows: Fixture['rows'] = { value: [] }
  const sessionOpened = { value: true }
  const turnRunning = { value: false }
  const draftBorrowed = { value: false }
  let stops = 0
  let reads = 0
  const ports: TerminalLifecyclePorts = {
    reportFrameError: error => { frameErrors.push(error) },
    notice: message => { notices.push(message) },
    copyRows: () => { reads += 1; return rows.value },
    activeSession: () => SESSION,
    sessionOpened: () => sessionOpened.value,
    turnRunning: () => turnRunning.value,
    stopClock: () => { stops += 1 },
    exit: code => { exits.push(code) },
    draftText: () => DRAFT,
    draftBorrowed: () => draftBorrowed.value,
    holdDraft: text => { held.push(text) },
    writeDraft: text => { written.push(text) },
  }
  const lifecycle = createTerminalLifecycle(ctx, ports)
  const writes: string[] = []
  vi.spyOn(lifecycle.terminal, 'write').mockImplementation((text: string) => { writes.push(text) })
  const unload = (): void => { teardown() }
  teardowns.push(unload)
  return {
    lifecycle, unload, notices, frameErrors, exits, written, held, rows,
    stops: () => stops,
    reads: () => reads,
    sessionOpened, turnRunning, draftBorrowed, writes,
  }
}

describe('createTerminalLifecycle exits', () => {
  it('prints control-bearing failures literally after returning the terminal', async () => {
    const given = fixture()
    given.lifecycle.requestExit(FAILED_EXIT_STATUS, CONTROL_REASON)
    await vi.waitFor(() => { expect(given.exits).toEqual([FAILED_EXIT_STATUS]) })
    expect(given.writes).toContain(`\ndsh-tui: ${LITERAL_REASON}\n`)
    expect(given.stops()).toBe(1)
  })

  it('leaves at once with the reason the caller gave and the session to come back to', async () => {
    const given = fixture()
    given.lifecycle.requestExit(0, 'interrupted')
    await vi.waitFor(() => { expect(given.exits).toEqual([0]) })

    // The screen goes back before the words: a reader who asked to leave must see
    // the shell rather than a notice drawn over the alternate screen.
    expect(given.writes[0]).toBe('\u001b]0;\u0007')
    expect(given.writes).toContain('\ndsh-tui: interrupted\n')
    expect(given.writes).toContain(`\n${resumeHint(String(SESSION), PROFILE_NAME)}\n`)
    expect(given.stops()).toBe(1)
  })

  it('offers no resume for a run that opened no session', async () => {
    const given = fixture()
    given.sessionOpened.value = false
    given.lifecycle.requestExit(0, 'interrupted')
    await vi.waitFor(() => { expect(given.exits).toEqual([0]) })

    // The identity a run without a session was launched with names no log, so
    // pointing at it would send the reader to a conversation that does not exist.
    expect(given.writes.join('')).not.toContain(resumeHint(String(SESSION), PROFILE_NAME))
    expect(given.writes).toContain('\ndsh-tui: interrupted\n')
  })

  it('says nothing the caller did not give it', async () => {
    const given = fixture()
    given.lifecycle.requestExit(0)
    await vi.waitFor(() => { expect(given.exits).toEqual([0]) })

    // A plain quit has no reason to print: a line claiming one would read as an
    // explanation the reader never asked for.
    expect(given.writes.join('')).not.toContain('dsh-tui:')
  })

  it('leaves once however many exits are asked for', async () => {
    const given = fixture()
    given.lifecycle.requestExit(0)
    given.lifecycle.requestExit(3, 'a second ask')
    await vi.waitFor(() => { expect(given.exits).toEqual([0]) })

    // A quit key and a supervisor signal can cross; a second leaving surface would
    // write the shell back twice and stop a clock nothing owns any more.
    expect(given.stops()).toBe(1)
    expect(given.writes.filter(text => text === '\u001b]0;\u0007')).toHaveLength(1)
    expect(given.exits).toEqual([0])
  })

  it('takes a supervisor signal as the quit it runs, and stops listening', async () => {
    const given = fixture()
    const before = process.listenerCount('SIGTERM')
    const remove = given.lifecycle.signalShutdown()
    process.emit('SIGTERM', 'SIGTERM')
    await vi.waitFor(() => { expect(given.exits).toEqual([SIGTERM_STATUS]) })

    // A signal ends the process from outside, so the surface has to leave the
    // alternate screen the way a quit does or the reader keeps a screen no prompt
    // is drawn in.
    expect(given.writes).toContain('\ndsh-tui: interrupted\n')
    expect(process.listenerCount('SIGTERM')).toBe(before)
    remove()
  })
})

describe('createTerminalLifecycle terminal ownership', () => {
  it('drops terminal writes and defers the exit while the reader\'s editor owns the screen', async () => {
    vi.stubEnv('VISUAL', fakeEditor(' edited'))
    vi.stubEnv('EDITOR', '')
    const given = fixture()
    given.turnRunning.value = true
    const swallowed = windowTitle('/elsewhere', 'working')

    given.lifecycle.editDraft()
    expect(given.lifecycle.handedOver()).toBe(true)
    given.lifecycle.writeTerminal(swallowed)
    expect(given.writes).not.toContain(swallowed)

    // An exit asked for now would put the shell behind a child that is still
    // running, so it waits for the screen to come back.
    given.lifecycle.requestExit(7, 'interrupted')
    expect(given.lifecycle.exited()).toBe(false)
    expect(given.exits).toEqual([])
    expect(given.stops()).toBe(0)

    await vi.waitFor(() => { expect(given.written).toEqual([`${DRAFT} edited`]) })
    await vi.waitFor(() => { expect(given.exits).toEqual([7]) })
    expect(given.lifecycle.handedOver()).toBe(false)
    // The title is state this surface owns and the handoff swallowed its changes,
    // so a turn that ran while the editor was open is named again on return.
    expect(given.writes).toContain(windowTitle(process.cwd(), 'working'))
  })

  it('parks an edited draft behind a question that borrowed the bar', async () => {
    vi.stubEnv('VISUAL', fakeEditor(' edited'))
    vi.stubEnv('EDITOR', '')
    const given = fixture()
    given.draftBorrowed.value = true

    given.lifecycle.editDraft()
    await vi.waitFor(() => { expect(given.held).toEqual([`${DRAFT} edited`]) })

    // Writing it into the bar would answer a question the reader never answered.
    expect(given.written).toEqual([])
  })

  it('keeps the screen its own when the handoff cannot stop the surface', () => {
    vi.stubEnv('VISUAL', fakeEditor(' edited'))
    vi.stubEnv('EDITOR', '')
    const given = fixture()
    given.lifecycle.tui.start()
    vi.spyOn(given.lifecycle.terminal, 'write').mockImplementation(() => { throw new Error('the tty is gone') })

    given.lifecycle.editDraft()

    // A stop that failed leaves the screen ours; leaving the flag up would
    // suppress every later title and defer every exit for good.
    expect(given.lifecycle.handedOver()).toBe(false)
    expect(given.notices).toEqual(['could not use the edited draft: the tty is gone'])
    expect(given.written).toEqual([])
  })

  it('says what is missing when the reader has no editor to open', () => {
    vi.stubEnv('VISUAL', '')
    vi.stubEnv('EDITOR', '')
    const given = fixture()

    given.lifecycle.editDraft()

    expect(given.notices).toEqual([NO_EDITOR])
    expect(given.lifecycle.handedOver()).toBe(false)
    expect(given.written).toEqual([])
  })

  it('puts a copied selection on the clipboard as the sequence the terminal reads', async () => {
    const given = fixture()
    const box = frameBlock(['hello'], 12, { text: line => line, border: rule => rule, framed: true })
    given.rows.value = box.copy
    // The screen owns the frame, so the drawn rows only exist once it is up.
    given.lifecycle.tui.start()
    given.lifecycle.tui.setLayoutRoot({ render: () => [...box.drawn], invalidate: () => {} })
    given.lifecycle.tui.renderNow(true)

    // A drag across the drawn message: the box the surface painted comes back with
    // the words, and the rows it kept are what take the shape back off.
    sendInput(given.lifecycle.tui, '\u001b[<0;1;2M')
    sendInput(given.lifecycle.tui, '\u001b[<32;12;2M')

    expect(await given.lifecycle.tui.copyActiveSelectionToClipboard()).toBe(true)
    expect(given.writes.at(-1)).toBe(clipboardSequence('hello'))
    expect(given.reads()).toBe(1)
  })

  it('refuses a copy while a child owns the terminal instead of writing to it', async () => {
    vi.stubEnv('VISUAL', fakeEditor(' edited'))
    vi.stubEnv('EDITOR', '')
    const given = fixture()
    given.lifecycle.tui.start()
    given.lifecycle.tui.setLayoutRoot({ render: () => ['hello'], invalidate: () => {} })
    given.lifecycle.tui.renderNow(true)

    given.lifecycle.editDraft()
    const before = given.writes.length
    sendInput(given.lifecycle.tui, '\u001b[<0;1;1M')
    sendInput(given.lifecycle.tui, '\u001b[<32;6;1M')

    // The editor owns the tty, so an OSC 52 here would land on its screen.
    expect(await given.lifecycle.tui.copyActiveSelectionToClipboard()).toBe(false)
    expect(given.writes.length).toBe(before)
    expect(given.reads()).toBe(0)
    await vi.waitFor(() => { expect(given.written).toEqual([`${DRAFT} edited`]) })
  })

  it('reports the first frame a component cannot draw and keeps the last good one', () => {
    const given = fixture()
    const frameFailure = new Error('frame failed')
    given.lifecycle.tui.start()
    given.lifecycle.tui.onFrameError = error => given.frameErrors.push(error)
    given.lifecycle.tui.addChild({ render: () => { throw frameFailure }, invalidate: () => {} })

    given.lifecycle.tui.renderNow()
    given.lifecycle.tui.renderNow()

    // A repaint a broken component fails again is the same news; repeating it
    // would loop the renderer instead of telling the reader once.
    expect(given.frameErrors).toEqual([frameFailure])
  })
})

describe('createTerminalLifecycle teardown', () => {
  it('unwinds the disposers in reverse and hands the screen back when the host unloads', () => {
    const given = fixture()
    given.lifecycle.tui.start()
    const order: string[] = []
    given.lifecycle.disposers.push(() => order.push('first'), () => order.push('second'), () => order.push('third'))

    given.unload()

    // Restoring the terminal is the one thing that must happen even when boot
    // fails halfway, so the surface's own registrations unwind newest first.
    expect(order).toEqual(['third', 'second', 'first'])
    expect(given.lifecycle.disposed()).toBe(true)
    expect(given.writes.join('')).toContain('\u001b[?1049l')
  })

  it('does not restart a screen the host unloaded while the editor was open', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-lifecycle-gate-'))
    created.push(directory)
    const started = join(directory, 'started')
    const release = join(directory, 'release')
    vi.stubEnv('VISUAL', fakeEditor(' edited', { started, release }))
    vi.stubEnv('EDITOR', '')
    const given = fixture()
    given.lifecycle.editDraft()
    try {
      await vi.waitFor(() => { expect(existsSync(started)).toBe(true) })
      given.unload()
    } finally {
      writeFileSync(release, '')
    }
    await vi.waitFor(() => { expect(given.written).toEqual([`${DRAFT} edited`]) })

    // Starting again would paint on a terminal this process is done with, into
    // listeners that are gone.
    expect(given.lifecycle.disposed()).toBe(true)
    expect(given.lifecycle.handedOver()).toBe(true)
  })
})
