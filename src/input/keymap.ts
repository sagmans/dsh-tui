import { KeybindingsManager, TUI_KEYBINDINGS, type KeyId, matchesKey, setKeybindings } from '@earendil-works/pi-tui'
import { pastedText } from '../input.ts'
import type { Submission } from './submission.ts'

/** The key that starts a chord when the reader configures nothing. */
export const DEFAULT_PREFIX_KEY: KeyId = 'ctrl+x'

/** How long an armed chord waits for the key that follows it, in seconds. */
export const DEFAULT_PREFIX_WINDOW_S = 2

/** What each key the surface answers itself does, named so a handler map cannot drift from the table. */
export type SurfaceKeyId = 'toolDetail' | 'subCalls' | 'reasoning' | 'effort' | 'back' | 'interrupt'

/** A key the surface answers itself: how help names it, and what a prefix may not take. */
export interface SurfaceKey {
  readonly id: SurfaceKeyId
  readonly key: KeyId
  readonly label: string
}

/**
 * The keys the surface answers before anything else sees them.
 *
 * One table because two readers need it: the help line, and the refusal of a
 * prefix that would shadow a key the reader already relies on. A key added to
 * the listener without a row here would be one a reader could quietly steal.
 */
export const SURFACE_KEYS: readonly SurfaceKey[] = [
  { id: 'toolDetail', key: 'ctrl+o', label: 'tool detail' },
  { id: 'subCalls', key: 'ctrl+y', label: 'nested calls' },
  { id: 'reasoning', key: 'shift+tab', label: 'reasoning' },
  { id: 'effort', key: 'ctrl+t', label: 'reasoning effort' },
  { id: 'back', key: 'ctrl+b', label: 'back to this session' },
  { id: 'interrupt', key: 'ctrl+c', label: 'interrupt or exit' },
]

/**
 * Keys the terminal itself consumes.
 *
 * A prefix made of one of these can never arrive, because the tty turns it into
 * flow control, so accepting it would configure a chord that silently does
 * nothing at all.
 */
const TERMINAL_OWNED_KEYS: readonly KeyId[] = ['ctrl+q']

/**
 * The keys that send what the reader wrote.
 *
 * A prompt is prose before it is a request, so the bar keeps Enter for the
 * paragraph — it breaks the line on the library's own newline keys — and asks
 * for one of these chords to post what is in it. The same table keeps a prefix
 * from taking a key the reader needs to send with.
 */
export const EDITOR_SUBMIT_KEYS: readonly KeyId[] = ['ctrl+enter', 'alt+enter', 'ctrl+s']

/**
 * Install the submit chords in place of the library's own Enter.
 *
 * The library reads a key before the bar does, so the binding is changed where
 * it is read rather than intercepted: every other meaning of a press, including
 * the guard that keeps a borrowed bar from submitting an answer, stays the
 * library's own. Bindings are process-wide, which suits a surface that draws on
 * the only terminal it has.
 */
export function installEditorKeybindings(): void {
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { 'tui.input.submit': [...EDITOR_SUBMIT_KEYS] }))
}

/** The modifiers a key id may carry. */
const MODIFIERS = new Set(['ctrl', 'alt', 'shift', 'super'])

/** A chord needs one of these: Shift alone is a capital letter, not a chord. */
const CHORD_MODIFIERS = new Set(['ctrl', 'alt', 'super'])

/** A chord finishes on one character key, so a name like `enter` cannot arrive as text. */
const CHORD_KEY = /^[a-z0-9]$/u

/** Whether the reader wrote a modifier chord, which is the only shape a prefix may take. */
function isChordShape(raw: string): boolean {
  const parts = raw.split('+')
  const key = parts.pop()
  if (key === undefined || !CHORD_KEY.test(key)) return false
  const modifiers = new Set(parts)
  // A repeat would mean the reader wrote something the terminal cannot report.
  if (modifiers.size !== parts.length || modifiers.size === 0 || modifiers.size > MODIFIERS.size) return false
  for (const modifier of modifiers) if (!MODIFIERS.has(modifier)) return false
  return [...modifiers].some(modifier => CHORD_MODIFIERS.has(modifier))
}

/**
 * The key a reader may put in `dsh-tui.prefix`, or a refusal naming why not.
 *
 * A prefix shadows every other meaning its key had, so a key this surface
 * already answers, or one the terminal keeps for itself, is refused rather than
 * accepted and then behaving as neither.
 */
export function validatePrefix(raw: string): KeyId {
  // Ownership is checked before shape: a key the surface already answers is
  // refused for that reason, which is the one a reader can act on.
  const taken = SURFACE_KEYS.find(entry => entry.key === raw)
  if (taken !== undefined) throw new Error(`prefix "${raw}" is the surface's own ${taken.label} key`)
  if (EDITOR_SUBMIT_KEYS.includes(raw as KeyId)) throw new Error(`prefix "${raw}" is the editor's submit key`)
  if (TERMINAL_OWNED_KEYS.includes(raw as KeyId)) throw new Error(`prefix "${raw}" is the terminal's own key`)
  if (!isChordShape(raw)) throw new Error(`prefix "${raw}" must be a modifier chord like ctrl+x`)
  // The shape above admits exactly the modifier chords of the KeyId union.
  return raw as KeyId
}

/** The keys the surface answers itself, as help lists them. */
export function surfaceKeysLine(): string {
  return SURFACE_KEYS.map(entry => `${entry.key} ${entry.label}`).join(' · ')
}

/** One chord: the key that follows the prefix, and the line that key asks for. */
export interface ChordBinding {
  readonly key: string
  readonly submission: Submission
  readonly label: string
}

/**
 * The keys a chord may finish with.
 *
 * A chord is the command line spelled shorter, so a row carries the very
 * submission `classifySubmission` would produce for the same request: one
 * dispatcher answers both, and a chord cannot drift from its command.
 */
export const CHORD_BINDINGS: readonly ChordBinding[] = [
  { key: 'm', submission: { kind: 'model', argument: '' }, label: 'model' },
  { key: 'y', submission: { kind: 'copy' }, label: 'copy' },
]

/** How the chords read wherever the reader asks for them. */
export function chordKeysLine(prefix: string): string {
  return `${prefix} then ${CHORD_BINDINGS.map(binding => `${binding.key} ${binding.label}`).join(' · ')}`
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

/** The letter a press produced, or undefined when it was not a plain key press. */
function chordKey(data: string): string | undefined {
  if (pastedText(data) !== undefined) return undefined
  return data.length === 1 && data >= ' ' ? data.toLowerCase() : undefined
}

/**
 * The two keys between a prefix and an action.
 *
 * Only the prefix and a bound second key are consumed: a key that finishes
 * nothing is handed back, because a chord that swallowed the reader's typing
 * would cost more than one that did nothing.
 */
export class ChordReader {
  private armed = false
  private expiry: unknown

  constructor(
    private readonly prefix: () => KeyId,
    private readonly windowMs: () => number,
    private readonly onExpire: () => void,
    private readonly timers: ChordTimers = SYSTEM_TIMERS,
  ) {}

  /** Whether a chord is waiting for its next key, which is what the footer says. */
  get pending(): boolean {
    return this.armed
  }

  /**
   * The armed chord as the footer prints it, or undefined when nothing is armed.
   *
   * Only the prefix: the footer has to say that a key is waiting, not recite the
   * map — a reader who wants the chords asks /help, and a narrow terminal would
   * cut the list anyway.
   */
  hint(): string | undefined {
    return this.armed ? this.prefix() : undefined
  }

  /** End the chord, whatever ends it: its key, its window, or a keymap change. */
  disarm(): void {
    this.armed = false
    if (this.expiry === undefined) return
    this.timers.cancel(this.expiry)
    this.expiry = undefined
  }

  /** Apply one key press; only a press that started or finished a chord is consumed. */
  handle(data: string): ChordResult | undefined {
    if (!this.armed) {
      if (!matchesKey(data, this.prefix())) return undefined
      this.armed = true
      const windowMs = this.windowMs()
      // A window of zero is the reader asking for a sticky chord: nothing but
      // the next key ends it.
      if (windowMs > 0) {
        this.expiry = this.timers.schedule(() => {
          this.armed = false
          this.expiry = undefined
          this.onExpire()
        }, windowMs)
      }
      return { kind: 'armed' }
    }
    this.disarm()
    const key = chordKey(data)
    const binding = key === undefined ? undefined : CHORD_BINDINGS.find(entry => entry.key === key)
    return binding === undefined ? undefined : { kind: 'action', binding }
  }
}
