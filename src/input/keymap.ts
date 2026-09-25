import { KeybindingsManager, TUI_KEYBINDINGS, matchesKey, setKeybindings, type KeyId } from '@earendil-works/pi-tui'
import { defaultKeymap, keysFor, type Keymap } from './actions.ts'
import { ACTION_CATALOG, LIBRARY_KEY_ADDITIONS } from './action-catalog.ts'
import { ENTER_KEY } from './key-press.ts'
import type { Submission } from './submission.ts'

/** How long an armed chord waits for the key that follows it, in seconds. */
export const DEFAULT_PREFIX_WINDOW_S = 2

/** The keys that start a chord when the reader configures nothing. */
export const DEFAULT_PREFIX_KEYS: readonly KeyId[] = keysFor(defaultKeymap(), 'chord.prefix')

/** The first shipped prefix, for the places that need one key rather than the list. */
export const DEFAULT_PREFIX_KEY: KeyId = DEFAULT_PREFIX_KEYS[0]!

/**
 * The command each chord stands for.
 *
 * A chord is the command line spelled shorter, so a row carries the very
 * submission `classifySubmission` would produce for the same request: one
 * dispatcher answers both, and a chord cannot drift from its command.
 */
const CHORD_SUBMISSIONS: Readonly<Record<string, Submission>> = {
  'chord.model': { kind: 'model', argument: '' },
  'chord.plan': { kind: 'plan' },
  'chord.copy': { kind: 'copy' },
  'chord.stash': { kind: 'stash-draft' },
  'chord.stashes': { kind: 'stash-list' },
  // The editor, like the stash, only exists as a chord: a typed command has
  // already consumed the line it would otherwise have carried.
  'chord.editor': { kind: 'editor' },
  'chord.keys': { kind: 'keys', argument: '' },
  // The chord starts the session a typed `/new` starts, without the line that
  // would have replaced the draft in the bar.
  'chord.new': { kind: 'new', title: '' },
  'chord.undo': { kind: 'undo' },
  'chord.redo': { kind: 'redo' },
}

/** One chord: the key that follows the prefix, and the line that key asks for. */
export interface ChordBinding {
  readonly key: KeyId
  readonly submission: Submission
  readonly label: string
}

/** The chords in force, in catalog order. */
export function chordBindings(map: Keymap): readonly ChordBinding[] {
  const found: ChordBinding[] = []
  for (const action of ACTION_CATALOG) {
    if (action.layer !== 'chord' || action.id === 'chord.prefix') continue
    const submission = CHORD_SUBMISSIONS[action.id]
    if (submission === undefined) continue
    for (const key of keysFor(map, action.id)) found.push({ key, submission, label: action.label })
  }
  return found
}

/** How the chords read wherever the reader asks for them. */
export function chordKeysLine(map: Keymap): string {
  return `${keysFor(map, 'chord.prefix').join(', ')} then ${chordBindings(map).map(binding => `${binding.key} ${binding.label}`).join(' · ')}`
}

/** The keys the surface answers itself, as help lists them. */
export function surfaceKeysLine(map: Keymap): string {
  const found: string[] = []
  for (const action of ACTION_CATALOG) {
    if (action.layer !== 'surface') continue
    for (const key of keysFor(map, action.id)) found.push(`${key} ${action.label}`)
  }
  return found.join(' · ')
}

/**
 * The library bindings a map implies.
 *
 * Only the rows the reader wrote are sent, so every key they did not touch
 * keeps whatever the library ships. The prompt bar's two actions are always
 * sent, because both need the bar's own guard and therefore differ from the
 * library's defaults even when the reader never wrote them. A row this surface
 * adds a key to is sent for the same reason: the library reads that key itself,
 * so a default the surface only holds on paper would never open the search.
 */
export function libraryOverrides(map: Keymap): Record<string, KeyId[]> {
  const overrides: Record<string, KeyId[]> = {}
  for (const action of ACTION_CATALOG) {
    if (action.layer !== 'library') continue
    if (!map.written.has(action.id) && LIBRARY_KEY_ADDITIONS[action.id] === undefined) continue
    overrides[action.id] = [...keysFor(map, action.id)]
  }
  overrides['tui.input.submit'] = [...keysFor(map, 'prompt.submit')]
  // Enter is served by the bar itself: the library reads that press as a line
  // break before it ever looks for a submit key, so installing it here would
  // only take the completion menu's own Enter away.
  overrides['tui.input.newLine'] = keysFor(map, 'prompt.newLine').filter(key => key !== ENTER_KEY)
  return overrides
}

/**
 * Install a map into the library's own registry.
 *
 * The library reads a key before the bar does, so the binding is changed where
 * it is read rather than intercepted. Bindings are process-wide, which suits a
 * surface that draws on the only terminal it has.
 */
export function installKeybindings(map: Keymap): void {
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, libraryOverrides(map)))
}

/** What the prompt bar reads before the library reads anything. */
export interface PromptKeys {
  readonly submit: readonly KeyId[]
  readonly newLine: readonly KeyId[]
  /** Whether a plain press of Return breaks the line, which is the bar's own guard. */
  readonly enterBreaksLine: boolean
}

/** What the bar answers itself, read from the map on every press so an edit lands live. */
export function promptKeys(map: Keymap): PromptKeys {
  const submit = keysFor(map, 'prompt.submit')
  const newLine = keysFor(map, 'prompt.newLine')
  return {
    submit,
    newLine,
    enterBreaksLine: newLine.includes(ENTER_KEY),
  }
}

/** What one press asked the surface to do while a chord was armed. */
export type ChordResult =
  | { readonly kind: 'armed' }
  | { readonly kind: 'action'; readonly binding: ChordBinding }

/** The timer a chord schedules, injected so a test can run the window itself. */
export interface ChordTimers {
  schedule(run: () => void, delayMs: number): unknown
  cancel(handle: unknown): void
}

const SYSTEM_TIMERS: ChordTimers = {
  schedule: (run, delayMs) => setTimeout(run, delayMs),
  cancel: handle => {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

/**
 * The two keys between a prefix and an action.
 *
 * Only the prefix and a bound second key are consumed: a key that finishes
 * nothing is handed back, because a chord that swallowed the reader's typing
 * would cost more than one that did nothing.
 */
export class ChordReader {
  private armed: KeyId | undefined
  private expiry: unknown

  constructor(
    private readonly prefixes: () => readonly KeyId[],
    private readonly bindings: () => readonly ChordBinding[],
    private readonly windowMs: () => number,
    private readonly onExpire: () => void,
    private readonly timers: ChordTimers = SYSTEM_TIMERS,
  ) {}

  /** Whether a chord is waiting for its next key, which is what the footer says. */
  get pending(): boolean {
    return this.armed !== undefined
  }

  /**
   * The armed chord as the footer prints it, or undefined when nothing is armed.
   *
   * Only the prefix: the footer has to say that a key is waiting, not recite the
   * map — a reader who wants the chords asks /help, and a narrow terminal would
   * cut the list anyway.
   */
  hint(): string | undefined {
    return this.armed
  }

  /** End the chord, whatever ends it: its key, its window, or a keymap change. */
  disarm(): void {
    this.armed = undefined
    if (this.expiry === undefined) return
    this.timers.cancel(this.expiry)
    this.expiry = undefined
  }

  /** Apply one key press; only a press that started or finished a chord is consumed. */
  handle(data: string): ChordResult | undefined {
    if (this.armed === undefined) {
      // Every configured prefix is a way in, and the footer names the one that
      // was actually pressed: a list is a list of alternatives, not a sequence.
      const armed = this.prefixes().find(key => matchesKey(data, key))
      if (armed === undefined) return undefined
      this.armed = armed
      const windowMs = this.windowMs()
      // A window of zero is the reader asking for a sticky chord: nothing but
      // the next key ends it.
      if (windowMs > 0) {
        this.expiry = this.timers.schedule(() => {
          this.armed = undefined
          this.expiry = undefined
          this.onExpire()
        }, windowMs)
      }
      return { kind: 'armed' }
    }
    this.disarm()
    // Matching the key rather than a typed character keeps a paste from ever
    // counting as the second key of a chord.
    const binding = this.bindings().find(entry => matchesKey(data, entry.key))
    return binding === undefined ? undefined : { kind: 'action', binding }
  }
}
