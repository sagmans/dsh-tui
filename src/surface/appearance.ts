import type { KeyId } from '@earendil-works/pi-tui'
import type { Context } from '@deepseek-ai/cordis'
import { defaultKeymap, type Keymap } from '../input/actions.ts'
import { DEFAULT_PREFIX_KEYS, DEFAULT_PREFIX_WINDOW_S } from '../input/keymap.ts'
import { createDeferredNotice, type NoticeSink } from '../settings-notice.ts'
import { createTheme, forwardEditorTheme, forwardMarkdownTheme, type TuiTheme } from '../theme.ts'
import { detectColourMode, type ColourMode } from '../theme-capability.ts'
import { renderThemeTable } from '../theme-command.ts'
import { DEFAULT_THEME, builtinNames, builtinThemesDir, ensureThemesHome, exportTheme, loadThemes, themesHomeDir, watchThemes } from '../theme-files.ts'
import { defaultSettings, toOverrides, type MermaidMode, type TuiSettings } from '../theme-settings.ts'
import type { ToolDisplayTable } from '../tool-display.ts'
import { ThemePicker } from '../ui/theme-picker.ts'
import { DEFAULT_VIEW_STATE, type ViewState } from '../ui/view.ts'
import { createAppearancePreferences } from './appearance-preferences.ts'
import type { Picker } from './modal-input.ts'
import type { PromptInput } from './prompt-input.ts'

/** One second in the unit a chord window is scheduled in. */
const MS_PER_SECOND = 1000

/**
 * What the appearance owner needs from the surface that composes it.
 *
 * The sinks are ports because the caches they clear belong to the markdown view and
 * the transcript view. The keyboard is a reader because the settings scope applies
 * before the prompt bar's own owner exists, and the chord an edit has to end is
 * armed at that moment.
 */
export interface AppearancePorts {
  /** Whether colour was asked for at launch; the flag outranks anything configured. */
  readonly color: () => boolean
  /**
   * The theme the row's own configuration pins, or nothing when it pins none.
   *
   * Read from the row rather than taken from the section, because a harness that
   * keeps configuration per row has no `dsh-tui:` section to write a name into:
   * the row is then the only layer a profile patch can carry a theme in.
   */
  readonly rowTheme: string | undefined
  /** Keep source Config references live rather than capturing their startup values. */
  readonly rowSettings: () => unknown
  /** Source Loader can apply live edits only when its schema runtime created native references. */
  readonly rowSettingsLive: boolean
  readonly notice: (message: string) => void
  readonly render: () => void
  readonly invalidateMarkdown: () => void
  readonly invalidateView: () => void
  /** The keys an edit re-installs, and the chord it has to end. */
  readonly keybindings: () => Pick<PromptInput, 'installBindings' | 'disarmChord'>
  /** Run a list the surface answers for; the modal owner drives every gate and picker. */
  readonly openPicker: (picker: Picker) => Promise<string | undefined>
}

/**
 * The surface's appearance, rebuilt whenever the reader's settings change.
 *
 * Renderers hold this object for the life of the session, so the current theme
 * is swapped *behind* a stable delegate rather than reassigned: every row then
 * reads one whole table, and a repaint can never observe a half-applied one.
 * `--no-color` still outranks anything configured.
 */
export interface Appearance {
  readonly theme: TuiTheme
  /** The folds the transcript is drawn with, and the keys that flip them. */
  readonly viewState: () => ViewState
  readonly toggleCards: () => void
  readonly toggleSubCalls: () => void
  readonly toggleReasoning: () => void
  readonly mermaidMode: () => MermaidMode
  readonly toolDisplay: () => ToolDisplayTable
  readonly keymap: () => Keymap
  readonly prefixKeys: () => readonly KeyId[]
  readonly prefixWindowMs: () => number
  /** Whether prompts are recorded and offered, and the cap on how many. */
  readonly historyEnabled: () => boolean
  readonly historyGhost: () => boolean
  readonly historyMaxEntries: () => number
  /** Print whatever the settings scope held back, where the reader can read it. */
  readonly openNotices: (sink: NoticeSink) => void
  readonly registerSection: () => void
  readonly createThemesHome: () => void
  /** Register the settings listener; the answer takes it back off. */
  readonly settingsListener: () => () => void
  /** Watch the reader's own themes; the answer stops the watch. */
  readonly watchThemes: () => () => void
  /** Carry out one `theme` command line. */
  readonly runThemeCommand: (argument: string) => void
}

/**
 * The reader's appearance and display preferences, and the theme's lifetime.
 *
 * Every preference is read through a getter rather than captured, and the theme
 * table is replaced behind a delegate the renderers already hold, because the
 * document is hot-reloaded and the shade the reader saves has to reach a session
 * that is already on screen.
 */
export function createAppearance(ctx: Context, ports: AppearancePorts): Appearance {
  const themeMode = (): ColourMode => (ports.color() ? detectColourMode(process.env) : 'none')
  /**
   * The themes this session can draw.
   *
   * Read from disk rather than compiled in, so a file the reader saves is a theme
   * the moment the save lands. Held beside the settings rather than inside them
   * because the two answer different questions: the section says which name the
   * reader chose, and this says which names exist — including the one they typed
   * into the directory a second ago.
   */
  const themesHome = themesHomeDir()
  let themeLibrary = loadThemes(themesHome, builtinThemesDir())
  /**
   * A refused settings edit, kept until the surface can show it: stderr is
   * behind the alt screen, and the section is read on a schedule of its own.
   */
  const settingsNotice = createDeferredNotice()
  let current = createTheme(themeMode())
  /**
   * The section as it was last read.
   *
   * Held so a preview can rebuild the table without reading the document again:
   * the picker repaints on every arrow key, and a read there would report a
   * refused section once per press.
   */
  let appliedSection: TuiSettings | undefined
  /**
   * The theme the picker's cursor is on, while its list is open.
   *
   * A preview is a name and nothing else — the document is not written — so
   * leaving the list is one more rebuild from the section, and a session that
   * ends mid-preview has still persisted only what the reader chose.
   */
  let previewTheme: string | undefined
  /**
   * The theme in force: the reader's section, then the name the row pins, then
   * whatever file answers to no name at all.
   *
   * One question asked at two scopes. A section belongs to the settings document,
   * so a reader who has one is naming a theme for it; the row belongs to the
   * profile, and a harness that keeps configuration per row has no document left
   * to hold a name — which is why the row is read here, below the section and
   * above the default, rather than as the only answer.
   */
  const themeName = (section: TuiSettings): string | undefined => section.theme ?? (preferences.configBacked() ? undefined : ports.rowTheme)
  const applyTheme = (section: TuiSettings): void => {
    // The row under the cursor outranks both while a list is open, so a theme is
    // judged on the reader's own transcript before it is taken.
    current = createTheme(themeMode(), toOverrides({ ...section, theme: previewTheme ?? themeName(section) }, themeLibrary))
  }
  /** Repaint the surface: both caches hold rows drawn under the table this replaced. */
  const restyle = (): void => {
    ports.invalidateMarkdown()
    ports.invalidateView()
    ports.render()
  }
  /**
   * Show a theme without choosing it.
   *
   * The list's cursor is the preview: every row paints the surface and writes
   * nothing, so two themes are compared on the reader's own transcript rather
   * than on a name. Clearing the name puts back what the document says, which is
   * what cancelling the list has to leave behind.
   */
  const showTheme = (name: string | undefined): void => {
    previewTheme = name
    // Nothing to rebuild from before the first read, and nothing to show either.
    if (appliedSection === undefined) return
    applyTheme(appliedSection)
    restyle()
  }
  const theme: TuiTheme = {
    get revision() { return current.revision },
    get color() { return current.color },
    style: (token, text) => current.style(token, text),
    rich: (raw, options) => current.rich(raw, options),
    cut: (text, width, ellipsis) => current.cut(text, width, ellipsis),
    glyph: token => current.glyph(token),
    visible: token => current.visible(token),
    // Forwarded rather than read, because the editor and the markdown view keep
    // the theme object they were built with: a settings change has to reach them
    // through a stable delegate or they would keep the boot appearance.
    editor: forwardEditorTheme(() => current.editor),
    markdown: forwardMarkdownTheme(() => current.markdown),
  }
  /**
   * Rows the reader has opened by key. The model stays untouched; only the view
   * reads this, and a click on one message overrides it there. A thought starts
   * folded: it is the longest, least scannable row in the transcript, so leaving
   * it open pushes the answer a reader came for off the screen, and a folded row
   * still names itself and its key. Cards start from the reader's own `tools:`
   * settings, and a PTC card's calls start open for the opposite reason: each is
   * one clipped line under a header that already names the program.
   */
  const viewState = { ...DEFAULT_VIEW_STATE }
  const toggleCards = (): void => {
    viewState.expandCards = !viewState.expandCards
  }
  const toggleSubCalls = (): void => {
    viewState.expandSubCalls = !viewState.expandSubCalls
  }
  const toggleReasoning = (): void => {
    viewState.expandReasoning = !viewState.expandReasoning
  }
  /**
   * How a reply's mermaid fences draw, seeded from the reader's section.
   *
   * The transform reads this per render instead of capturing it, because the
   * settings document is hot-reloaded and a session already on screen has to
   * follow the edit.
   */
  let mermaidMode: MermaidMode = defaultSettings().mermaid
  /** How each tool's cards draw; the settings document owns it and the view reads it live. */
  let toolDisplay: ToolDisplayTable = defaultSettings().tools
  /** The keys that start a chord, and how long one waits; the settings document owns all of it. */
  let prefixKeys: readonly KeyId[] = DEFAULT_PREFIX_KEYS
  let prefixWindowMs = DEFAULT_PREFIX_WINDOW_S * MS_PER_SECOND
  /** Every action's keys in force; the settings document owns it and a press reads it live. */
  let keymap: Keymap = defaultKeymap()
  /** Whether prompts are recorded and offered, and the cap on how many; the settings document owns all three. */
  let historyEnabled = false
  let historyGhost = false
  let historyMaxEntries = defaultSettings().history.maxEntries
  /**
   * Seed the display the reader configured.
   *
   * The key toggles nested calls for one session, but a settings edit is a
   * deliberate act, so it re-seeds and becomes the new starting point; the
   * mermaid mode and the per-tool card fold have no key of their own and only
   * ever come from the document. Installing the keys, and ending a chord armed
   * under the map this edit replaced, belong to the prompt bar's owner.
   */
  const applyDisplay = (section: TuiSettings): void => {
    viewState.expandSubCalls = section.subcalls === 'inline'
    mermaidMode = section.mermaid
    toolDisplay = section.tools
    prefixKeys = section.prefixes
    prefixWindowMs = section.prefixWindow * MS_PER_SECOND
    keymap = section.keymap
    ports.keybindings().installBindings()
    historyEnabled = section.history.enabled
    historyGhost = section.history.ghost
    historyMaxEntries = section.history.maxEntries
    ports.keybindings().disarmChord()
  }
  /**
   * Read the reader's section once and apply everything it configures.
   *
   * One read per change, because a refused section is reported on the way past:
   * reading it once per field would show the reader the same refusal twice.
   */
  let applyingSettings = false
  const applySettings = (): void => {
    // describe() can synchronously announce its first snapshot while it is being read.
    if (applyingSettings) return
    applyingSettings = true
    try {
      const section = preferences.read()
      previewTheme = undefined
      reportMissingTheme(section)
      applyTheme(section)
      appliedSection = section
      applyDisplay(section)
    } finally {
      applyingSettings = false
    }
  }
  /**
   * Say so when the reader named a theme that nothing answers to.
   *
   * The schema cannot refuse the name: a theme is a file, so the set of names is
   * known to the directory rather than to this build, and one can stop answering
   * between two reads. Falling back to the default without a word would leave the
   * reader looking at shades they did not choose, so the refusal lands here
   * instead — beside the read that found it, and alongside the rest of the
   * section, which is still theirs.
   */
  const reportMissingTheme = (section: TuiSettings): void => {
    const name = themeName(section)
    if (name === undefined || themeLibrary.get(name) !== undefined) return
    settingsNotice.post(`dsh-tui theme "${name}" is not a theme · themes: ${themeLibrary.names().join(' · ')} · the default, ${DEFAULT_THEME}, is drawn instead`)
  }
  /**
   * Choose a theme from a list the screen follows.
   *
   * Enter writes the choice through the settings document, the same path a typed
   * name takes, so what lands is what the reader was looking at. Leaving the list
   * restores the theme in force, because the document never changed while they
   * looked.
   */
  const openThemePicker = async (): Promise<void> => {
    const picked = await ports.openPicker(new ThemePicker(
      () => themeLibrary,
      // What the surface draws right now, so a name pinned in the row is the
      // row the list opens on instead of reading as no choice at all.
      () => appliedSection === undefined ? ports.rowTheme : themeName(appliedSection),
      () => keymap,
      theme => showTheme(theme?.name),
    ))
    if (picked === undefined) {
      showTheme(undefined)
      return
    }
    // The row stays on screen until the document carries it: restoring first
    // would flash the theme the reader just left. The write clears the preview as
    // it lands, and a write that fails says so, leaving a theme that is still one
    // of theirs rather than shades nothing chose.
    preferences.chooseTheme(picked)
  }
  const runThemeCommand = (argument: string): void => {
    // A bare command is the list: a theme is judged by looking at it, so
    // choosing one belongs in a list the screen follows rather than in a name
    // the reader has to already know.
    if (argument === '') {
      void openThemePicker()
      return
    }
    const [head = '', ...rest] = argument.split(/\s+/u)
    // The table answers the other question a theme raises — which layer drew a
    // shade — and stays reachable by name now that the list has the command.
    if (head === 'tokens') {
      // The table answers for the appearance on screen, not only for the
      // document: a row-pinned theme would otherwise read as every shade
      // untouched, which is the opposite of the question this command answers.
      const section = appliedSection ?? preferences.read()
      for (const line of renderThemeTable(toOverrides({ ...section, theme: previewTheme ?? themeName(section) }, themeLibrary), themeLibrary)) ports.notice(line)
      ports.render()
      return
    }
    // The one way a built-in becomes editable. Its file ships inside the
    // package and the next version replaces it, so a reader who wants to
    // change one needs a copy that is theirs — and the copy is a theme the
    // moment it lands, which is why the table is re-read rather than patched.
    if (head === 'export') {
      const chosen = rest.join(' ').trim()
      if (chosen === '') {
        ports.notice(`theme export · which built-in? ${builtinNames(themeLibrary).join(' · ')}`)
        ports.render()
        return
      }
      const outcome = exportTheme(themeLibrary, chosen)
      if (outcome.ok) {
        themeLibrary = loadThemes(themesHome, builtinThemesDir())
        ports.notice(`theme · exported ${chosen} to ${outcome.path} · /theme ${outcome.select} applies it`)
      } else {
        ports.notice(outcome.problem)
      }
      ports.render()
      return
    }
    // A name nothing answers to is refused by name, like an unknown key
    // layer: the reader asked for something, so the answer lists names.
    if (themeLibrary.get(head) === undefined) {
      ports.notice(`unknown theme "${head}" · themes: ${themeLibrary.names().join(' · ')}`)
      ports.render()
      return
    }
    preferences.chooseTheme(head)
  }
  const preferences = createAppearancePreferences(ctx, {
    rowSettings: ports.rowSettings,
    rowSettingsLive: ports.rowSettingsLive,
    applied: () => appliedSection,
    apply: applySettings,
    restyle,
    restorePreview: () => showTheme(undefined),
    disableHistory: () => { historyEnabled = false; historyGhost = false },
    notice: ports.notice,
    problem: message => settingsNotice.post(message),
  })
  let reportedThemes = new Set<string>()
  const reportThemes = (): void => {
    // Only what is newly wrong: the watcher re-reads the whole directory on every
    // save, so an unfixed file would otherwise repeat its complaint on each one,
    // and a reader who has just been told is not helped by being told again.
    const problems = themeLibrary.problems()
    for (const problem of problems) {
      if (!reportedThemes.has(problem)) settingsNotice.post(problem)
    }
    reportedThemes = new Set(problems)
  }
  /**
   * The reader's own themes: created, reported, and then watched.
   *
   * Created because a directory that is not there is a command that cannot work —
   * `/theme export` names a path the reader should find where the surface said it
   * would be. Watched because a theme is a file they are editing by hand, so
   * saving one is how they ask for it; a session that needed a restart per shade
   * would make the whole table useless for tuning. Everything unreadable is
   * reported through the deferred notice rather than stderr, which the alternate
   * screen is drawn over.
   */
  const createThemesHome = (): void => {
    for (const problem of ensureThemesHome(themesHome)) settingsNotice.post(problem)
    reportThemes()
  }
  const watchThemeFiles = (): (() => void) => watchThemes(themesHome, () => {
    themeLibrary = loadThemes(themesHome, builtinThemesDir())
    reportThemes()
    // The file that was just saved may be the theme already in force, so the
    // table is rebuilt rather than only repainted.
    applySettings()
    restyle()
  })
  return {
    theme,
    viewState: () => viewState,
    toggleCards,
    toggleSubCalls,
    toggleReasoning,
    mermaidMode: () => mermaidMode,
    toolDisplay: () => toolDisplay,
    keymap: () => keymap,
    prefixKeys: () => prefixKeys,
    prefixWindowMs: () => prefixWindowMs,
    historyEnabled: () => preferences.allowsHistory('enabled', historyEnabled),
    historyGhost: () => preferences.allowsHistory('ghost', historyGhost),
    historyMaxEntries: () => historyMaxEntries,
    openNotices: sink => settingsNotice.open(sink),
    registerSection: preferences.register,
    createThemesHome,
    settingsListener: preferences.listen,
    watchThemes: watchThemeFiles,
    runThemeCommand,
  }
}
