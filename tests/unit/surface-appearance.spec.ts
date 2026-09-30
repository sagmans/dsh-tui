import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createKeymapRegistry, type KeymapRegistry } from '@/keymaps.ts'
import { chordBindings } from '@/input/keymap.ts'
import { keymapRows } from '@/keys-command.ts'
import { createAppearance, type AppearancePorts } from '@/surface/appearance.ts'
import { TUI_SETTINGS_NAMESPACE } from '@/theme-settings.ts'
import { DEFAULT_PREFIX_KEYS, DEFAULT_PREFIX_WINDOW_S } from '@/input/keymap.ts'
import { defaultKeymap } from '@/input/actions.ts'
import { builtinNames, builtinThemesDir, DEFAULT_THEME, loadThemes, themesHomeDir } from '@/theme-files.ts'
import { defaultSettings } from '@/theme-settings.ts'
import { DEFAULT_VIEW_STATE } from '@/ui/view.ts'
import type { Picker } from '@/surface/modal-input.ts'

/** The theme the fixture pins on the row when a case needs one in force. */
const ROW_THEME = 'deepseek-blue'
/** A theme file the reader wrote, in the shape the loader accepts. */
const OWN_THEME = 'palette:\n  accent: \'#123456\'\ntokens:\n  tool.title: { fg: accent }\n'
/** YAML that cannot parse, which is what a save caught mid-write looks like. */
const BROKEN_THEME = 'palette: [unclosed\n'
/** The divisor the surface reads the chord window's seconds through. */
const MS_PER_SECOND = 1000
/** The refusal a theme choice gets when nothing on the host can own the section. */
const WRITE_UNSUPPORTED = 'the settings service cannot write the section; the patch was not applied'
/** Rounds a case re-makes a save for while the watcher has not reported it. */
const SAVE_ROUNDS = 40
/** Pause between those rounds, which together bound the wait at ten seconds. */
const SAVE_ROUND_MS = 250
/**
 * Re-makes a save until the directory watcher reports it.
 *
 * The watcher answers on the filesystem's own schedule, and on a busy machine a
 * single event can sit behind other IO for seconds — longer than any honest
 * bound — while a repeated save is a fresh event every round. What the cases
 * assert is that a save is read, not that one write's event wins a race with
 * the scheduler.
 */
const saveUntil = async (file: string, body: string, read: () => boolean): Promise<void> => {
  for (let round = 0; !read() && round < SAVE_ROUNDS; round += 1) {
    writeFileSync(file, body)
    await new Promise(resolve => setTimeout(resolve, SAVE_ROUND_MS))
  }
  expect(read()).toBe(true)
}
/**
 * The ceiling a case that waits on the watcher runs under.
 *
 * A case can wait the full settle bound more than once, and the runner's own
 * default ceiling is shorter than that, so the case would be reported as a
 * timeout rather than as the missing report it is waiting for.
 */
const WATCH_TEST_TIMEOUT_MS = 20_000

const created: string[] = []
let home = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-appearance-'))
  created.push(home)
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('NO_COLOR', '')
  vi.stubEnv('COLORTERM', 'truecolor')
  vi.stubEnv('TERM', 'xterm-256color')
})

afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** The theme directory the module reads, built from the module's own answer. */
const themesDir = (): string => join(home, 'themes')

/** Every name the surface knows, read the way the module reads it. */
const names = (): readonly string[] => loadThemes(themesDir(), builtinThemesDir()).names()

/** The built-ins a copy can be made of, in the order the refusal lists them. */
const builtins = (): string[] => builtinNames(loadThemes(themesDir(), builtinThemesDir()))

interface Given {
  readonly appearance: ReturnType<typeof createAppearance>
  readonly notices: string[]
  /** Everything the deferred settings notice held back until the screen was up. */
  readonly openNotices: () => string[]
  readonly renders: () => number
  readonly invalidated: () => number
  readonly pickers: Picker[]
  /** What the open list settles on; undefined is the reader cancelling it. */
  readonly pick: { value: string | undefined }
  readonly rowSettings: { value: Record<string, unknown> }
  /** The settings events the surface subscribed to, by name. */
  readonly listeners: Map<string, (...args: unknown[]) => void>
  readonly lastPicker: () => Picker | undefined
}

function fixture(service?: unknown, options: { readonly rowTheme?: string; readonly color?: boolean; readonly pluginKeymaps?: KeymapRegistry } = {}): Given {
  const listeners = new Map<string, (...args: unknown[]) => void>()
  let attach = (): void => {}
  const ctx = {
    fiber: { entry: { options: { id: TUI_SETTINGS_NAMESPACE } } },
    inject: (_names: string[], callback: (ctx: unknown) => void) => {
      attach = () => { if (service !== undefined) callback({ settings: service }) }
      attach()
    },
    on: (event: string, callback: (...args: unknown[]) => void) => {
      listeners.set(event, callback)
      return () => { listeners.delete(event) }
    },
  } as unknown as Context
  const notices: string[] = []
  const held: string[] = []
  const pickers: Picker[] = []
  const pick = { value: undefined as string | undefined }
  const rowSettings = { value: {} as Record<string, unknown> }
  let renders = 0
  let invalidated = 0
  const ports: AppearancePorts = {
    pluginKeymaps: options.pluginKeymaps,
    color: () => options.color ?? true,
    rowTheme: options.rowTheme,
    rowSettings: () => rowSettings.value,
    rowSettingsLive: true,
    notice: message => { notices.push(message) },
    render: () => { renders += 1 },
    invalidateMarkdown: () => { invalidated += 1 },
    invalidateView: () => { invalidated += 1 },
    keybindings: () => ({ installBindings: () => {}, disarmChord: () => {} }),
    openPicker: async picker => {
      pickers.push(picker)
      return pick.value
    },
  }
  const appearance = createAppearance(ctx, ports)
  const openNotices = (): string[] => { appearance.openNotices(message => held.push(message)); return held }
  return {
    appearance,
    notices,
    openNotices,
    renders: () => renders,
    invalidated: () => invalidated,
    pickers,
    pick,
    rowSettings,
    listeners,
    lastPicker: () => pickers.at(-1),
  }
}

/**
 * A settings service that keeps the section, the way a coordinating host does.
 *
 * The write is recorded rather than asserted through the painter, because the
 * question a choice raises is what landed in the document.
 */
function installSectionService(options: {
  readonly writable?: boolean
  readonly initial?: Record<string, unknown>
  /** A host can announce a snapshot while the section is being read. */
  readonly announceOnRead?: boolean
} = {}) {
  let value = options.initial ?? {}
  let announce = (): void => {}
  const service = {
    writable: options.writable,
    update: async (_ns: string, patch: object) => { value = { ...value, ...patch } },
    installSection: (
      _owner: unknown,
      _ns: string,
      _schema: unknown,
      _entry: unknown,
      hooks: { setSource: (source: () => unknown) => void; onChange: () => void },
    ) => {
      hooks.setSource(() => {
        if (options.announceOnRead === true) announce()
        return value
      })
      announce = hooks.onChange
    },
  }
  return {
    service,
    section: () => value,
    write: (patch: Record<string, unknown>) => { value = { ...value, ...patch } },
    announce: () => announce(),
  }
}

/**
 * A settings service that only knows how to read and write a Config row.
 *
 * This is the generation whose authoritative reader is describe(), which is the
 * path a row-pinned theme has to take.
 */
function configService(initial: Record<string, unknown>) {
  let value = initial
  const calls: Array<{ readonly ns: string; readonly patch: object }> = []
  const service = {
    describe: () => [{ ns: TUI_SETTINGS_NAMESPACE, value, revision: 3 }],
    update: async (ns: string, patch: object) => { calls.push({ ns, patch }); value = { ...value, ...patch } },
  }
  return { service, calls }
}

describe('createAppearance theme export', () => {
  it('offers every built-in the package ships a file for', () => {
    const given = fixture()

    given.appearance.runThemeCommand('export')

    // A reader who wants to change a built-in needs a copy that is theirs, so the
    // list has to name every one a copy could be made of.
    expect(given.notices).toEqual([`theme export · which built-in? ${builtins().join(' · ')}`])
    expect(given.renders()).toBe(1)
  })

  it('copies the file behind a built-in and names the copy to apply', () => {
    const given = fixture()
    const chosen = builtins()[0] as string
    const source = join(builtinThemesDir(), `${chosen}.yaml`)

    given.appearance.runThemeCommand(`export ${chosen}`)

    const copy = join(themesDir(), `${chosen}_export_1.yaml`)
    expect(given.notices).toEqual([`theme · exported ${chosen} to ${copy} · /theme ${chosen}_export_1 applies it`])
    // The bytes are copied rather than re-serialized, so the comments a built-in
    // carries — the record of why a shade is that shade — arrive with it.
    expect(readFileSync(copy, 'utf8').endsWith(readFileSync(source, 'utf8'))).toBe(true)
  })

  it('numbers a second copy rather than clobbering the one the reader edited', () => {
    const chosen = builtins()[0] as string
    mkdirSync(themesDir(), { recursive: true })
    writeFileSync(join(themesDir(), `${chosen}_export_1.yaml`), OWN_THEME)
    const given = fixture()

    given.appearance.runThemeCommand(`export ${chosen}`)

    expect(given.notices[0]).toContain(`to ${join(themesDir(), `${chosen}_export_2.yaml`)}`)
    expect(readFileSync(join(themesDir(), `${chosen}_export_1.yaml`), 'utf8')).toBe(OWN_THEME)
  })

  it('refuses a name the package does not ship, and lists what it does', () => {
    const given = fixture()

    given.appearance.runThemeCommand('export no-such-theme')

    expect(given.notices).toEqual([`themes: no theme named "no-such-theme"; the surface ships ${names().join(', ')}`])
    expect(given.renders()).toBe(1)
  })

  it('refuses to copy a theme that is already the reader\'s own', () => {
    mkdirSync(themesDir(), { recursive: true })
    writeFileSync(join(themesDir(), 'mine.yaml'), OWN_THEME)
    const given = fixture()

    given.appearance.runThemeCommand('export mine')

    // An export is the sanctioned way a built-in becomes editable, so a file the
    // reader already owns would only be overwritten by a copy of itself.
    expect(given.notices).toEqual([`themes: "mine" is already yours (${join(themesDir(), 'mine.yaml')}); this command copies a built-in`])
  })

  it('lists the copy as a theme the list now offers', () => {
    const given = fixture()
    const chosen = builtins()[0] as string

    given.appearance.runThemeCommand(`export ${chosen}`)
    given.appearance.runThemeCommand('')

    // The table is re-read rather than patched, because the copy is a theme the
    // moment it lands.
    expect(given.lastPicker()?.card().title).toBe(`theme · ${names().length} available`)
    expect(names()).toContain(`${chosen}_export_1`)
  })

  it('refuses a name nothing answers to and says which names do', () => {
    const given = fixture()

    given.appearance.runThemeCommand('no-such-theme')

    expect(given.notices).toEqual([`unknown theme "no-such-theme" · themes: ${names().join(' · ')}`])
    expect(given.renders()).toBe(1)
  })

  it('answers the shade question from the appearance on screen', () => {
    const given = fixture(undefined, { rowTheme: ROW_THEME })

    given.appearance.runThemeCommand('tokens')

    // The table answers for the appearance in force, not only for the document: a
    // row-pinned theme would otherwise read as every shade untouched.
    expect(given.notices.join('\n')).toContain(ROW_THEME)
    expect(given.renders()).toBe(1)
  })
})

describe('createAppearance theme choice', () => {
  it('writes the choice the list settled on into the settings document', async () => {
    const settings = installSectionService({ initial: { theme: ROW_THEME } })
    const given = fixture(settings.service, { rowTheme: ROW_THEME })
    given.appearance.registerSection()
    given.pick.value = DEFAULT_THEME

    given.appearance.runThemeCommand('')

    await vi.waitFor(() => { expect(given.notices).toContain(`theme · ${DEFAULT_THEME} · written to the settings document`) })
    expect(settings.section()).toMatchObject({ theme: DEFAULT_THEME })
    expect(given.renders()).toBeGreaterThan(0)
    expect(given.invalidated()).toBeGreaterThan(0)
  })

  it('says the choice was not recorded when the settings service cannot write', async () => {
    const settings = installSectionService({ writable: false })
    const given = fixture(settings.service)
    given.appearance.registerSection()
    given.openNotices()

    given.appearance.runThemeCommand(DEFAULT_THEME)

    // A write the durable owner refused must not be reported as a change: the
    // reader is told the patch did not land instead of seeing shades nothing kept.
    await vi.waitFor(() => { expect(given.openNotices().join('\n')).toContain('cannot write the section') })
    expect(settings.section()).toEqual({})
  })

  it('records the choice through a Config-backed row', async () => {
    const settings = configService({ theme: ROW_THEME })
    const given = fixture(settings.service, { rowTheme: ROW_THEME })
    given.appearance.registerSection()

    given.appearance.runThemeCommand(DEFAULT_THEME)

    await vi.waitFor(() => { expect(given.notices).toContain(`theme · ${DEFAULT_THEME} · written to the settings document`) })
    expect(settings.calls).toEqual([{ ns: TUI_SETTINGS_NAMESPACE, patch: { theme: DEFAULT_THEME } }])
  })

  it('paints the row under the cursor while the list is open and puts the document back on cancel', async () => {
    const settings = installSectionService({ initial: { theme: ROW_THEME } })
    const given = fixture(settings.service, { rowTheme: ROW_THEME })
    given.appearance.registerSection()
    const painted = given.appearance.theme.style('status.cwd', 'cwd')

    given.appearance.runThemeCommand('')
    const list = given.lastPicker()
    if (list === undefined) throw new Error('the theme list was never opened')
    // The row the cursor lands on is the preview: the list itself is the surface's
    // way of judging a theme, and nothing is written while it is open.
    list.handleKey('\u001b[B')
    const previewed = given.appearance.theme.style('status.cwd', 'cwd')

    // Cancelling puts back what the document says, because it never changed.
    await vi.waitFor(() => { expect(given.appearance.theme.style('status.cwd', 'cwd')).toBe(painted) })
    expect(previewed).not.toBe(painted)
    expect(settings.section()).toEqual({ theme: ROW_THEME })
  })
})

describe('createAppearance settings changes', () => {
  it('follows a change the settings service announces', () => {
    const settings = installSectionService({ initial: { theme: ROW_THEME } })
    const given = fixture(settings.service, { rowTheme: ROW_THEME })
    given.appearance.registerSection()
    const painted = given.appearance.theme.style('status.cwd', 'cwd')
    const renders = given.renders()

    settings.write({ theme: DEFAULT_THEME })
    settings.announce()

    // The document is the durable owner, so a change it announces repaints a
    // session already on screen rather than waiting for a reload.
    expect(given.appearance.theme.style('status.cwd', 'cwd')).not.toBe(painted)
    expect(given.renders()).toBeGreaterThan(renders)
  })

  it('repaints on the settings events the host emits', () => {
    const settings = installSectionService({ initial: { theme: ROW_THEME } })
    const given = fixture(settings.service, { rowTheme: ROW_THEME })
    given.appearance.registerSection()
    given.appearance.settingsListener()
    const painted = given.appearance.theme.style('status.cwd', 'cwd')
    const renders = given.renders()
    const [event] = [...given.listeners.keys()]
    const changed = given.listeners.get(event ?? '') ?? (() => {})

    settings.write({ theme: DEFAULT_THEME })
    changed(TUI_SETTINGS_NAMESPACE)

    expect(given.appearance.theme.style('status.cwd', 'cwd')).not.toBe(painted)
    expect(given.renders()).toBeGreaterThan(renders)

    // Another plugin's namespace is its own business: the surface reads one
    // section, and repainting for every edit would thrash the screen.
    const quiet = given.renders()
    changed('dsh-something-else')
    expect(given.renders()).toBe(quiet)
  })

  it('survives a host that announces a snapshot while the section is still read', () => {
    const settings = installSectionService({ initial: { theme: ROW_THEME }, announceOnRead: true })
    const given = fixture(settings.service, { rowTheme: ROW_THEME })

    given.appearance.registerSection()

    // The announcement arrives mid-read, so applying it would reenter the read and
    // never settle; the surface takes the snapshot it is already holding.
    expect(given.appearance.theme.style('status.cwd', 'cwd')).toContain('cwd')
    expect(given.renders()).toBeGreaterThan(0)
  })

  it('says the patch was not applied when nothing can own the section', () => {
    const given = fixture()
    given.openNotices()

    given.appearance.runThemeCommand(DEFAULT_THEME)

    // The theme on screen changes either way, so the reader has to be told the
    // choice will not survive the session.
    expect(given.openNotices()).toEqual([WRITE_UNSUPPORTED])
  })

  it.each([
    [{ history: { enabled: 'no' } }, false, true],
    [{ history: { ghost: 'no' } }, true, false],
    [{ history: 'yes' }, false, false],
  ])('keeps the switches off that the raw user layer refuses: %j', (user, enabled, ghost) => {
    const service = {
      describe: () => [{ ns: TUI_SETTINGS_NAMESPACE, value: { history: { enabled: true, ghost: true } }, user, revision: 1 }],
      update: async () => {},
    }
    const given = fixture(service)
    given.appearance.registerSection()

    // The raw layer exists so a hand-edited document can refuse what the section
    // allows, and each switch is that reader's own: one refusal is not the other's.
    expect(given.appearance.historyEnabled()).toBe(enabled)
    expect(given.appearance.historyGhost()).toBe(ghost)
  })

  it('keeps both switches off when the user layer vanishes at the same revision', () => {
    let user: Record<string, unknown> | undefined = { history: { enabled: true } }
    const service = {
      describe: () => [{ ns: TUI_SETTINGS_NAMESPACE, value: { history: { enabled: true, ghost: true } }, user, revision: 1 }],
      update: async () => {},
    }
    const given = fixture(service)
    given.appearance.registerSection()
    expect(given.appearance.historyEnabled()).toBe(true)

    // A root omitted without the revision moving is an invalid document rather
    // than a removal, so no switch in it may be trusted.
    user = undefined
    expect(given.appearance.historyEnabled()).toBe(false)
    expect(given.appearance.historyGhost()).toBe(false)
  })

  it('lets the patch govern history for a row the document has no section for', () => {
    // A Config-backed row is configured by the profile patch, so the document
    // holds no section for it: reading that absence as an unreadable layer turned
    // a switch the patch had turned on into an opt-out, and every prompt went
    // unrecorded while the reader believed history was enabled.
    const service = { describe: () => [], update: async () => {} }
    const given = fixture(service)
    given.rowSettings.value = { history: { enabled: true, ghost: true } }

    given.appearance.registerSection()

    expect(given.appearance.historyEnabled()).toBe(true)
    expect(given.appearance.historyGhost()).toBe(true)
  })

  it('keeps prompt history off when the user layer cannot be read at all', () => {
    const service = {
      describe: () => { throw new Error('no descriptor for this namespace') },
      update: async () => {},
    }
    const given = fixture(service)

    given.appearance.registerSection()

    // Trusting an unreadable layer would record prompts a hand-edited document
    // asked not to keep.
    expect(given.appearance.historyEnabled()).toBe(false)
    expect(given.appearance.historyGhost()).toBe(false)
  })
})

describe('createAppearance legacy rows', () => {
  it.each([
    [{ theme: ROW_THEME, history: 'yes' }, 'history must be a mapping'],
    ['not a table at all', 'dsh-tui settings must be a mapping'],
  ])('refuses a row it cannot normalize rather than repairing it: %j', (row, problem) => {
    const service = {
      describe: () => [{ ns: TUI_SETTINGS_NAMESPACE, value: row, revision: 1 }],
      update: async () => {},
    }
    const given = fixture(service)

    given.appearance.registerSection()

    // A legacy row predates the section: repairing half of it would opt a reader
    // in who never touched the switches, so the whole row is refused by name.
    expect(given.openNotices()).toEqual([`ignoring dsh-tui settings: ${problem}`])
    expect(given.appearance.historyEnabled()).toBe(false)

    // The appearance falls back to the default rather than to the row's own theme.
    given.appearance.runThemeCommand('')
    expect(given.lastPicker()?.card().rows.find(entry => entry.current)?.label).toBe(DEFAULT_THEME)
  })
})

describe('createAppearance themes on disk', () => {
  it('says when the document names a theme nothing answers to', () => {
    const settings = installSectionService({ initial: { theme: 'no-such-theme' } })
    const given = fixture(settings.service)

    given.appearance.registerSection()

    // The schema cannot refuse the name — a theme is a file, so the set of names
    // belongs to the directory — and silence would leave the reader looking at
    // shades they did not choose.
    expect(given.openNotices().join('\n')).toBe(
      `dsh-tui theme "no-such-theme" is not a theme · themes: ${names().join(' · ')} · the default, ${DEFAULT_THEME}, is drawn instead`,
    )
  })

  it('creates the reader theme directory the export path was promised at', () => {
    const given = fixture()

    given.appearance.createThemesHome()

    expect(statSync(themesDir()).isDirectory()).toBe(true)
    expect(given.openNotices()).toEqual([])
  })

  it('reports an unreadable theme directory rather than starting without one', () => {
    mkdirSync(home, { recursive: true })
    // A file where the directory belongs is the crude case: the promise that a
    // path exists is what the reader acts on, so the failure has to be said.
    writeFileSync(themesDir(), 'not a directory')
    const given = fixture()

    given.appearance.createThemesHome()

    const problems = given.openNotices().join('\n')
    expect(problems).toContain(`themes: cannot create ${themesDir()}`)
    expect(problems).toContain(themesDir())
  })

  it('reports a broken file once, however often the directory is read', async () => {
    const given = fixture()
    given.appearance.createThemesHome()
    given.appearance.watchThemes()
    given.openNotices()
    const broken = (): string[] => given.openNotices().filter(line => line.includes('broken.yaml'))

    await saveUntil(join(themesDir(), 'broken.yaml'), BROKEN_THEME, () => broken().length === 1)

    // A later save re-reads the whole directory, so an unfixed file would
    // otherwise repeat its complaint on each one.
    const renders = given.renders()
    await saveUntil(join(themesDir(), 'other.yaml'), OWN_THEME, () => given.renders() > renders)

    expect(broken()).toHaveLength(1)
  }, WATCH_TEST_TIMEOUT_MS)

  it('re-reads the directory on a save and stops when the session ends', async () => {
    const given = fixture()
    given.appearance.createThemesHome()
    const unwatch = given.appearance.watchThemes()
    given.openNotices()

    await saveUntil(join(themesDir(), 'first.yaml'), BROKEN_THEME, () => given.openNotices().join('\n').includes('first.yaml'))

    unwatch()
    writeFileSync(join(themesDir(), 'second.yaml'), BROKEN_THEME)
    await new Promise(resolve => setTimeout(resolve, 400))

    // A watcher that outlived the surface would be a handle nobody closes, so the
    // answer stops the directory from being read again.
    expect(given.openNotices().join('\n')).not.toContain('second.yaml')
  }, WATCH_TEST_TIMEOUT_MS)
})

describe('createAppearance display', () => {
  it('flips the folds the reader asked for, one at a time', () => {
    const given = fixture()

    const view = given.appearance.viewState()
    expect(view).toEqual({ ...DEFAULT_VIEW_STATE })
    given.appearance.toggleCards()
    given.appearance.toggleSubCalls()
    given.appearance.toggleReasoning()

    // A fold is a view preference rather than a setting: the three toggles are
    // separate rows in the transcript, so one must not move another.
    expect(view).toEqual({
      expandCards: !DEFAULT_VIEW_STATE.expandCards,
      expandSubCalls: !DEFAULT_VIEW_STATE.expandSubCalls,
      expandReasoning: !DEFAULT_VIEW_STATE.expandReasoning,
    })
  })

  it('draws plain text when the terminal has no colour', () => {
    const given = fixture(undefined, { color: false })

    // Every paint goes through this one delegate, so a reader whose terminal
    // cannot colour must get their text back untouched rather than escapes
    // nothing renders.
    expect(given.appearance.theme.color).toBe(false)
    expect(given.appearance.theme.style('status.cwd', 'cwd')).toBe('cwd')
    expect(given.appearance.theme.rich('plain')).toBe('plain')
    expect(given.appearance.theme.markdown.heading('title')).toBe('title')
  })

  it('reads the display the settings document owns', () => {
    const given = fixture()

    expect(given.appearance.mermaidMode()).toBe(defaultSettings().mermaid)
    expect(given.appearance.toolDisplay()).toEqual(defaultSettings().tools)
    expect(given.appearance.prefixKeys()).toEqual(DEFAULT_PREFIX_KEYS)
    expect(given.appearance.prefixWindowMs()).toBe(DEFAULT_PREFIX_WINDOW_S * MS_PER_SECOND)
    expect(given.appearance.historyMaxEntries()).toBe(defaultSettings().history.maxEntries)
    expect(given.appearance.keymap()).toEqual(defaultKeymap())
  })

  it('paints through the one delegate the renderers already hold', async () => {
    const settings = installSectionService({ initial: { theme: ROW_THEME } })
    const given = fixture(settings.service, { rowTheme: ROW_THEME })
    given.appearance.registerSection()
    const theme = given.appearance.theme
    const revision = theme.revision
    const painted = theme.style('tool.title', 'title')
    expect(painted).toContain('38;2;103;158;254')

    expect(theme.color).toBe(true)
    expect(theme.cut('a row long enough to be cut', 4).length).toBeLessThan('a row long enough to be cut'.length)
    expect(theme.glyph('status.cwd')).toBe('')
    expect(theme.visible('status.cwd')).toBe(true)
    expect(theme.rich('plain text')).toContain('plain text')
    // The editor and the markdown view keep the theme they were built with, so
    // every part of the delegate has to answer for the theme in force.
    const editorPainted = theme.editor.borderColor('prompt')
    const markdownPainted = theme.markdown.heading('title')
    expect(editorPainted).toContain('38;2;103;158;254')
    expect(theme.editor.selectList.selectedPrefix('prompt')).toContain('prompt')
    expect(markdownPainted).toContain('38;2;103;158;254')

    given.pick.value = DEFAULT_THEME
    given.appearance.runThemeCommand('')
    await vi.waitFor(() => { expect(theme.style('tool.title', 'title')).toContain('38;2;129;151;247') })
    expect(theme.style('tool.title', 'title')).not.toBe(painted)
    expect(theme.editor.borderColor('prompt')).toContain('38;2;111;118;201')
    expect(theme.editor.borderColor('prompt')).not.toBe(editorPainted)
    expect(theme.markdown.heading('title')).toContain('38;2;181;181;255')
    expect(theme.markdown.heading('title')).not.toBe(markdownPainted)

    // A renderer holds this object for the whole session, so a theme change has to
    // reach it rather than replace it.
    expect(given.appearance.theme).toBe(theme)
    expect(theme.revision).toBeGreaterThan(revision)
  })
})

describe('createAppearance settings attachment', () => {
  it('says a section the settings service refused leaves prompt history off', () => {
    const given = fixture({ installSection: () => { throw new Error('the schema was refused') } })

    given.appearance.registerSection()

    expect(given.openNotices().join('\n')).toContain('the schema was refused · prompt history stays off until the section parses')
    expect(given.appearance.historyEnabled()).toBe(false)
    expect(given.appearance.historyGhost()).toBe(false)
  })

  it('takes both settings listeners back off when the surface ends', () => {
    const settings = installSectionService()
    const given = fixture(settings.service)
    given.appearance.registerSection()
    const remove = given.appearance.settingsListener()
    expect([...given.listeners.keys()].sort()).toEqual(['settings/document-updated'])

    remove()

    // The listener answers nothing once the surface is gone, and one left on sees
    // every later edit of a document nothing on screen follows.
    expect([...given.listeners.keys()]).toEqual([])
  })
})
const PLUGIN_ACTION_ID = 'plugin.example.options'
const PLUGIN_DEFAULT_KEY = 't'
const PLUGIN_REBOUND_KEY = 'v'

/** Real registry publication must update the painter's map, help, and keyboard together. */
describe('appearance plugin keymap catalog', () => {
  it('activates stored preferences on late registration and removes live rows with the owner', async () => {
    const registry = createKeymapRegistry()
    const given = fixture(undefined, { pluginKeymaps: registry })
    given.rowSettings.value = { keys: { [PLUGIN_ACTION_ID]: PLUGIN_REBOUND_KEY } }
    given.appearance.registerSection()
    const stop = given.appearance.settingsListener()
    const ctx = new Context()
    const owner = await ctx.plugin((scoped: Context) => { registry.register(scoped, { id: PLUGIN_ACTION_ID, layer: 'chord', defaultKeys: [PLUGIN_DEFAULT_KEY], label: 'example options', handler: async () => {} }) })
    try {
      expect(chordBindings(given.appearance.keymap()).find(row => row.submission.kind === 'plugin-action')?.key).toBe(PLUGIN_REBOUND_KEY)
      expect(keymapRows(given.appearance.keymap()).find(row => row.id === PLUGIN_ACTION_ID)?.label).toContain(PLUGIN_REBOUND_KEY)
      await owner.dispose()
      expect(chordBindings(given.appearance.keymap()).some(row => row.submission.kind === 'plugin-action')).toBe(false)
      expect(given.appearance.keymap().written.has(PLUGIN_ACTION_ID)).toBe(true)
      expect(given.notices).toEqual([])
    } finally { stop(); await owner.dispose() }
  })
})
it('reconciles registrations created before the appearance listener subscribes', async () => {
  const registry = createKeymapRegistry()
  const given = fixture(undefined, { pluginKeymaps: registry })
  given.rowSettings.value = { keys: { [PLUGIN_ACTION_ID]: PLUGIN_REBOUND_KEY } }
  given.appearance.registerSection()
  const ctx = new Context()
  const owner = await ctx.plugin((scoped: Context) => { registry.register(scoped, { id: PLUGIN_ACTION_ID, layer: 'chord', defaultKeys: [PLUGIN_DEFAULT_KEY], label: 'example options', handler: async () => {} }) })
  const stop = given.appearance.settingsListener()
  try { expect(chordBindings(given.appearance.keymap()).find(row => row.submission.kind === 'plugin-action')?.key).toBe(PLUGIN_REBOUND_KEY) }
  finally { stop(); await owner.dispose() }
})
