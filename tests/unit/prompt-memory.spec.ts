/**
 * The prompt's own memory: what a submitted line leaves behind, what the bar
 * offers back from it, and what the reader is told when it cannot be read.
 *
 * Every case points `DSH_HOME` at a scratch directory, because the store the
 * owner builds keeps its file under the harness home and the developer's own
 * history is theirs to keep.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { BLOCK_DESCRIPTIONS, DEFAULT_MAX_ENTRIES, HISTORY_FILE_NAME, HISTORY_SCHEMA_VERSION, type PromptEntry } from '@/agent/prompt-history.ts'
import { defaultKeymap } from '@/input/actions.ts'
import { createPromptMemory, type MemoryPicker, type PromptMemory } from '@/surface/prompt-memory.ts'
import { PromptStash } from '@/stash.ts'
import type { TuiTheme } from '@/theme.ts'
import { resetSequence } from '@/theme-resolver.ts'
import { TUI_SETTINGS_NAMESPACE } from '@/theme-settings.ts'
import { STASH_CLEAR_CHOICE } from '@/ui/stash-picker.ts'

/**
 * Reverse video the owner puts on the cursor cell so the cursor stays visible
 * on a ghost. The constant is private to the module, so the drawing is named
 * here in the one place that asserts it.
 */
const GHOST_CURSOR_PREFIX = '\u001b[7m'
const IO_FREE_PROMPT = 'cached history probe'
const IO_FREE_PREFIX = 'cached'
const IO_FREE_SUFFIX = ' history probe'

// Real disk reads still run; observing this boundary catches a future lazy load behind disabled ghosts.
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, readFile: vi.fn(fs.readFile) }
})

/** Refusal a bar borrowed by a question answers a park with; private to src/stash.ts. */
const EDITOR_BUSY_MESSAGE = 'the prompt bar is answering a question; finish or cancel it first'

/** Cap small enough that the table below reaches it in three records. */
const SMALL_CAP = 2

const SESSION = 'tui-session-1' as SessionId
const OTHER_SESSION = 'tui-session-2' as SessionId

let home = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-prompt-memory-'))
  vi.stubEnv('DSH_HOME', home)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

const historyFile = (): string => join(home, HISTORY_FILE_NAME)

const entry = (text: string, useCount = 1): PromptEntry => ({ text, updatedAt: '2024-01-01T00:00:00.000Z', useCount })

/** Put entries in front of the owner before it is built, the way a later run finds them. */
function seed(entries: readonly PromptEntry[]): void {
  writeFileSync(historyFile(), JSON.stringify({
    version: HISTORY_SCHEMA_VERSION,
    updatedAt: '2024-01-01T00:00:00.000Z',
    entries,
  }, null, 2))
}

function seedCorrupt(): void {
  writeFileSync(historyFile(), '{ not a history document')
}

/** A file a later build wrote, which this one must refuse rather than prune. */
function seedNewerSchema(): void {
  writeFileSync(historyFile(), JSON.stringify({
    version: HISTORY_SCHEMA_VERSION + 1,
    updatedAt: '2024-01-01T00:00:00.000Z',
    entries: [entry('from a later build')],
  }, null, 2))
}

interface Options {
  readonly historyEnabled?: () => boolean
  readonly historyGhost?: () => boolean
  readonly historyMaxEntries?: () => number
  readonly color?: boolean
  readonly visible?: boolean
  readonly editorAvailable?: () => boolean
  readonly draft?: string
  /** One answer per picker the owner opens, in the order it opens them. */
  readonly picks?: readonly (string | undefined)[]
}

type Harness = ReturnType<typeof harness>

function harness(options: Options = {}) {
  const notices: string[] = []
  const setTexts: string[] = []
  const pickers: MemoryPicker[] = []
  const picks = [...(options.picks ?? [])]
  const editor = { text: options.draft ?? '' }
  let renders = 0
  let session: SessionId = SESSION
  // The owner reads the theme per paint, so the fake answers the two questions
  // it asks and records nothing else.
  const theme = {
    revision: 0,
    color: options.color ?? true,
    style: (token: string, text: string) => `[${token}]${text}`,
    visible: () => options.visible ?? true,
  } as unknown as TuiTheme
  const memory = createPromptMemory({
    historyEnabled: options.historyEnabled ?? (() => true),
    historyGhost: options.historyGhost ?? (() => true),
    historyMaxEntries: options.historyMaxEntries ?? (() => DEFAULT_MAX_ENTRIES),
    theme,
    keymap: defaultKeymap,
    notice: text => {
      notices.push(text)
    },
    render: () => {
      renders += 1
    },
    editorText: () => editor.text,
    setEditorText: text => {
      setTexts.push(text)
    },
    editorAvailable: options.editorAvailable ?? (() => true),
    activeSession: () => session,
    // The bank this spec drives is the session-private one, which is the scope
    // its session-switching assertions describe.
    stashScope: 'session',
    openPicker: async picker => {
      pickers.push(picker)
      return picks.shift()
    },
  })
  return {
    memory,
    notices,
    editor,
    setTexts,
    pickers,
    renderCount: () => renders,
    /** Follow the surface to another session, the way an opened session does. */
    switchTo: (id: SessionId) => {
      session = id
    },
    /** Start a later step from a clean slate, so its own calls are the only signal. */
    reset: () => {
      notices.length = 0
      setTexts.length = 0
      pickers.length = 0
      renders = 0
    },
  }
}

/** The suffix the bar would draw after what is typed, as one assertion. */
const ghost = (memory: PromptMemory, text: string): string | undefined =>
  memory.ghostBrush.suggestion({ text, lines: [text], cursor: { line: 0, col: text.length } })

/** Wait for the store's first read of the file to land, so a case starts from it. */
async function loaded(given: Harness, count: number): Promise<void> {
  given.memory.runHistoryCommand('')
  await vi.waitFor(() => {
    if (!given.notices.some(text => text.startsWith(`${count} prompt`))) throw new Error('the history has not loaded')
  })
  given.reset()
}

describe('the ghost the bar draws', () => {
  it('probes only already-loaded history after recording is disabled', async () => {
    seed([entry(IO_FREE_PROMPT)])
    let enabled = true
    const given = harness({ historyEnabled: () => enabled })
    await loaded(given, 1)
    expect(vi.mocked(readFile)).toHaveBeenCalledWith(historyFile(), 'utf8')
    enabled = false
    const reads = vi.mocked(readFile)
    reads.mockClear()
    expect(given.memory.ghostBrush.enabled()).toBe(false)
    expect(ghost(given.memory, IO_FREE_PREFIX)).toBe(IO_FREE_SUFFIX)
    expect(ghost(given.memory, IO_FREE_PROMPT)).toBeUndefined()
    await Promise.resolve()
    expect(reads).not.toHaveBeenCalled()
  })

  it.each([
    { why: 'recording is off', options: { historyEnabled: () => false } },
    { why: 'the ghost is off', options: { historyGhost: () => false } },
    { why: 'the theme has no colour', options: { color: false } },
    { why: 'the ghost token is hidden', options: { visible: false } },
  ])('offers nothing when $why', ({ options }) => {
    const given = harness(options)

    // Colour is the affordance: without styling the suggestion would be
    // unreadable text the reader could still accept, which is worse than none,
    // so every switch has to be on rather than any of them.
    expect(given.memory.ghostBrush.enabled()).toBe(false)
  })

  it('offers the recorded prompt back when every switch is on', async () => {
    const given = harness()
    expect(given.memory.ghostBrush.enabled()).toBe(true)

    given.memory.record('fix the parser')
    await vi.waitFor(() => {
      expect(ghost(given.memory, 'fix the')).toBe(' parser')
    })
  })

  it('reverses the cursor cell so the cursor is not lost in the ghost', () => {
    const given = harness()

    expect(given.memory.ghostBrush.paint(' parser', 'rest')).toBe('[editor.ghost] parser')
    expect(given.memory.ghostBrush.paint(' parser', 'cursor'))
      .toBe(GHOST_CURSOR_PREFIX + '[editor.ghost] parser' + resetSequence())
  })
})

describe('what is remembered', () => {
  it('keeps nothing while the settings have recording off', async () => {
    const given = harness({ historyEnabled: () => false })

    given.memory.record('never kept')
    given.memory.runHistoryCommand('')

    await vi.waitFor(() => {
      if (given.notices.length === 0) throw new Error('the count has not landed')
    })
    expect(given.notices).toEqual([`0 prompts recorded · ${historyFile()}`])
  })

  it('keeps no more prompts than the settings allow', async () => {
    const given = harness({ historyMaxEntries: () => SMALL_CAP })

    given.memory.record('one')
    given.memory.record('two')
    given.memory.record('three')
    await vi.waitFor(() => {
      expect(ghost(given.memory, 'thr')).toBe('ee')
    })

    // The cap comes from the settings document, read per mutation, so a reader
    // who lowers it does not wait for a restart to see the file stop growing.
    given.memory.runHistoryCommand('')
    await vi.waitFor(() => {
      if (given.notices.length === 0) throw new Error('the count has not landed')
    })
    expect(given.notices).toEqual([`${SMALL_CAP} prompts recorded · ${historyFile()}`])
  })

  it('moves a repeated prompt to the newest row instead of keeping it twice', async () => {
    const given = harness()

    given.memory.record('one')
    given.memory.record('two')
    given.memory.record('one')
    await loaded(given, 2)

    given.editor.text = ''
    await given.memory.openHistoryPicker()

    // A duplicate is moved rather than copied: the repeat has to resurface as
    // the newest suggestion without the list ever showing it twice.
    expect(given.pickers[0]?.card().title).toBe('prompt history · 2 recorded')
    expect(given.pickers[0]?.card().rows).toEqual([
      { label: 'one', description: '2 uses', current: true },
      { label: 'two', description: undefined, current: false },
    ])
  })
})

describe('reverse search over recorded prompts', () => {
  it('answers with the settings document when the history is off', async () => {
    const given = harness({ historyEnabled: () => false })

    await given.memory.openHistoryPicker()

    expect(given.notices).toEqual([`prompt history is disabled in ${TUI_SETTINGS_NAMESPACE} settings`])
    expect(given.pickers).toEqual([])
    expect(given.renderCount()).toBe(1)
  })

  it('says there is nothing to search rather than opening an empty list', async () => {
    const given = harness()

    await given.memory.openHistoryPicker()

    expect(given.notices).toEqual(['no prompt history yet'])
    expect(given.pickers).toEqual([])
    expect(given.renderCount()).toBe(1)
  })

  it('names why the history is unavailable instead of showing nothing', async () => {
    seedCorrupt()
    const given = harness()
    given.memory.runHistoryCommand('')
    await vi.waitFor(() => {
      if (!given.notices.some(text => text.includes('writes disabled: ' + BLOCK_DESCRIPTIONS.corrupt_history))) {
        throw new Error('the store has not refused the file')
      }
    })
    // The first read refused the file; the search has to say so rather than
    // open a list the reader would read as "I never wrote anything".
    expect(given.notices).toEqual([
      'prompt history is ' + BLOCK_DESCRIPTIONS.corrupt_history + '; writes are disabled and the file is left untouched',
      `0 prompts recorded · ${historyFile()} · writes disabled: ${BLOCK_DESCRIPTIONS.corrupt_history}`,
    ])

    await given.memory.openHistoryPicker()

    expect(given.notices.at(-1)).toBe('prompt history is unavailable: ' + BLOCK_DESCRIPTIONS.corrupt_history)
    expect(given.pickers).toEqual([])
  })

  it('answers a file from a later build in the same words the store does', async () => {
    seedNewerSchema()
    const given = harness()
    given.memory.runHistoryCommand('')
    await vi.waitFor(() => {
      if (!given.notices.some(text => text.includes('writes disabled: ' + BLOCK_DESCRIPTIONS.unsupported_schema))) {
        throw new Error('the store has not refused the file')
      }
    })
    // One condition, one name: the store's load warning already said "a newer
    // format", so the status line and the refusal answer in those words rather
    // than teaching the reader a second name for the same refusal.
    expect(given.notices.at(-1)).toBe(`0 prompts recorded · ${historyFile()} · writes disabled: ${BLOCK_DESCRIPTIONS.unsupported_schema}`)

    await given.memory.openHistoryPicker()

    expect(given.notices.at(-1)).toBe('prompt history is unavailable: ' + BLOCK_DESCRIPTIONS.unsupported_schema)
    expect(given.pickers).toEqual([])
  })

  it('seeds the search with the expanded draft and writes the pick back', async () => {
    seed([entry('fix the parser')])
    const given = harness({ draft: 'fix\nthe', picks: ['fix the parser'] })
    await loaded(given, 1)

    await given.memory.openHistoryPicker()

    // The expanded text is what the reader wrote: a pasted block sits in the bar
    // as a marker, and seeding with the marker would filter out the prompt it
    // came from. A pick replaces the draft, because that is the whole point of
    // searching for it.
    expect(given.pickers[0]?.card().title).toBe('prompt history · 1 recorded')
    expect(given.pickers[0]?.card().filter).toBe('fix the')
    expect(given.setTexts).toEqual(['fix the parser'])
    expect(given.renderCount()).toBe(1)
  })

  it('leaves the draft alone when the reader cancels', async () => {
    seed([entry('fix the parser')])
    const given = harness({ picks: [undefined] })
    await loaded(given, 1)

    await given.memory.openHistoryPicker()

    // The list was opened to look, not to lose what is already typed.
    expect(given.setTexts).toEqual([])
    expect(given.renderCount()).toBe(0)
  })
})

describe('the history command', () => {
  it.each([
    { entries: [entry('one')], said: '1 prompt recorded' },
    { entries: [entry('one'), entry('two')], said: '2 prompts recorded' },
  ])('shows where history is kept, in words the reader counts ($said)', async ({ entries, said }) => {
    seed(entries)
    const given = harness()
    await loaded(given, entries.length === 1 ? 1 : 2)

    given.memory.runHistoryCommand('')

    await vi.waitFor(() => {
      if (given.notices.length === 0) throw new Error('the answer has not landed')
    })
    expect(given.notices).toEqual([`${said} · ${historyFile()}`])
    expect(given.renderCount()).toBe(1)
  })

  it('refuses an argument it does not know instead of guessing', async () => {
    const given = harness()

    given.memory.runHistoryCommand('forget')

    await vi.waitFor(() => {
      if (given.notices.length === 0) throw new Error('the refusal has not landed')
    })
    expect(given.notices).toEqual(['usage: /history shows where history is kept · /history clear forgets every prompt'])
  })

  it.each([
    { entries: [entry('one')], count: 1, said: 'forgot 1 prompt' },
    { entries: [entry('one'), entry('two')], count: 2, said: 'forgot 2 prompts' },
  ])('forgets every prompt, in words the reader counts ($said)', async ({ entries, count, said }) => {
    seed(entries)
    const given = harness()
    await loaded(given, count)

    given.memory.runHistoryCommand('clear')

    await vi.waitFor(() => {
      if (given.notices.length === 0) throw new Error('the answer has not landed')
    })
    expect(given.notices).toEqual([said])

    given.memory.runHistoryCommand('')
    await vi.waitFor(() => {
      if (given.notices.length < 2) throw new Error('the count has not landed')
    })
    expect(given.notices.at(-1)).toBe(`0 prompts recorded · ${historyFile()}`)
  })

  it('refuses to claim a clear the file would never have had', async () => {
    seedCorrupt()
    const given = harness()
    await loaded(given, 0)

    given.memory.runHistoryCommand('clear')

    await vi.waitFor(() => {
      if (!given.notices.some(text => text.startsWith('prompt history is unavailable'))) {
        throw new Error('the refusal has not landed')
      }
    })
    // Saying "forgot 0 prompts" would describe a successful clear the reader
    // would meet again on the next start.
    expect(given.notices.at(-1)).toBe('prompt history is unavailable: ' + BLOCK_DESCRIPTIONS.corrupt_history)
  })

  it('reports a clear that failed instead of a count that never landed', async () => {
    seed([entry('one')])
    const given = harness()
    await loaded(given, 1)
    // The file is replaced by a directory: nothing can be read from it, and the
    // store refuses the clear rather than reporting one it could not write.
    rmSync(historyFile())
    mkdirSync(historyFile())

    given.memory.runHistoryCommand('clear')

    await vi.waitFor(() => {
      if (!given.notices.some(text => text.startsWith('could not clear'))) throw new Error('no failure was reported')
    })
    expect(given.notices.at(-1)).toBe('could not clear prompt history: the file is ' + BLOCK_DESCRIPTIONS.unreadable_history)
  })
})

describe('the prompt bank the surface routes to', () => {
  it('hands back the bank it built and parks a draft in the session in force', async () => {
    const given = harness({ draft: 'park me' })
    const bank = given.memory.buildStash()
    expect(bank).toBeInstanceOf(PromptStash)

    await bank.stashEditor()

    expect(bank.entryCount).toBe(1)
    // The draft is only cleared once the write landed, and the bar is the
    // surface's own port rather than a component this owner reaches into.
    expect(given.editor.text).toBe('park me')
    expect(given.setTexts).toEqual([''])
  })

  it('writes nothing into a bar that is answering a question', async () => {
    const given = harness({ editorAvailable: () => false })
    const bank = given.memory.buildStash()

    await bank.stashEditor()

    expect(bank.entryCount).toBe(0)
    expect(given.setTexts).toEqual([])
    expect(given.notices.at(-1)).toBe(EDITOR_BUSY_MESSAGE)
  })

  it('hands its list the pick and its confirm the destructive clear', async () => {
    const given = harness({ draft: 'park me', picks: [STASH_CLEAR_CHOICE] })
    const bank = given.memory.buildStash()
    await bank.stashEditor()
    given.reset()

    await bank.clear()

    // Clearing is irreversible, so the bank asks through the surface's picker
    // rather than acting on the command alone.
    expect(given.pickers[0]?.card().title).toBe('clear stash · 1 draft in this session')
    expect(bank.entryCount).toBe(0)
  })

  it('lists the parked drafts through the surface picker', async () => {
    const given = harness({ draft: 'park me' })
    const bank = given.memory.buildStash()
    await bank.stashEditor()
    given.reset()

    await bank.list(SESSION)

    // The bank owns what a draft is; where a list is drawn, and who holds the
    // keyboard while it is up, stay with the surface.
    expect(given.pickers[0]?.card().title).toBe(`stash · ${SESSION} · 1 draft`)
    expect(given.pickers[0]?.card().rows).toEqual([
      { label: '[0] park me', description: 'just now', current: true },
    ])
    expect(bank.entryCount).toBe(1)
  })

  it('follows the session just opened, so the count follows its drafts', async () => {
    const given = harness({ draft: 'park me' })
    const bank = given.memory.buildStash()
    await bank.stashEditor()
    expect(bank.entryCount).toBe(1)

    given.switchTo(OTHER_SESSION)
    given.memory.sessionOpened()

    // Two terminals in one checkout keep separate drafts, so the footer must
    // stop counting the session just left.
    await vi.waitFor(() => {
      expect(bank.entryCount).toBe(0)
    })
  })

  it('follows a session opened before any bank was built', () => {
    const given = harness()

    // The surface builds the bank where a pick can reach a picker, so a session
    // can open before there is one to follow.
    expect(() => given.memory.sessionOpened()).not.toThrow()
    expect(given.notices).toEqual([])
  })
})
