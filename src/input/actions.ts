import { Key, TUI_KEYBINDINGS, isKittyProtocolActive, matchesKey, setKittyProtocolActive, type KeyId } from '@earendil-works/pi-tui'

/**
 * Every action a reader may bind, in one table.
 *
 * Two provenances meet here. The surface's own actions are rows written out
 * with the keys they ship with; the library's actions are read from the
 * library's own table, so a key pi-tui adds becomes bindable without a second
 * list to maintain. An action has exactly one spelling, which is the spelling
 * the layer that reads it uses: a `tui.` id belongs to pi-tui, everything else
 * to this surface.
 */
export type ActionLayer = 'prompt' | 'surface' | 'chord' | 'gate' | 'question' | 'picker' | 'library'

/** One bindable action: what it is called, what it ships with, and what a reader may do to it. */
export interface Action {
  readonly id: string
  readonly layer: ActionLayer
  readonly defaultKeys: readonly KeyId[]
  readonly label: string
  /**
   * Whether a bare character may be bound to it.
   *
   * A whole key the reader types with is only theirs while it is armed: the
   * approval gate owns the keyboard for one decision, and a chord's second key
   * is live only between the prefix and the key after it. Everywhere else the
   * reader is writing prose, so a bare letter would be taken from them.
   */
  readonly mayUseBare: boolean
  /** Whether the list may be emptied, which is only honest for a key the library already ships unbound. */
  readonly mayUnbind: boolean
  /**
   * A shape this action insists on beyond "a key the reader may write".
   *
   * `chord` is for the key that starts a chord: it has to be one simple chord,
   * because it is consumed before anything else looks at the press.
   */
  readonly keyShape?: 'chord'
}

/** The names the surface's own handler map is keyed by. */
export type SurfaceActionId = 'toolDetail' | 'subCalls' | 'reasoning' | 'effort' | 'history' | 'back' | 'interrupt'

/** A key the tty answers before the application sees it. */
export const TERMINAL_OWNED_KEYS: readonly KeyId[] = ['ctrl+q']

/** The key a plain press of Return arrives as. */
export const ENTER_KEY: KeyId = 'enter'

/**
 * The named key a control character is the same press as.
 *
 * A terminal that reports no modifiers sends the control byte itself, so the
 * library matches Ctrl+M where it matches Return and Ctrl+I where it matches
 * Tab. Two rows that read one press have to be refused under the same name
 * however they spell it, or the reader keeps a binding their terminal answers
 * with a different action.
 */
const CONTROL_ALIASES: Readonly<Record<string, KeyId>> = {
  'ctrl+m': ENTER_KEY,
  'ctrl+i': 'tab',
  'ctrl+h': 'backspace',
  'ctrl+[': 'escape',
}

/** The press one key names, folded across the spellings a bare terminal cannot tell apart. */
export function pressOf(key: KeyId): string {
  return CONTROL_ALIASES[key] ?? key
}

/** The modifiers a key id may carry, in the order a canonical id writes them. */
const MODIFIER_ORDER = ['ctrl', 'shift', 'alt', 'super'] as const
const MODIFIERS: ReadonlySet<string> = new Set(MODIFIER_ORDER)

/** Spellings the library matches as the same key, folded so they cannot claim two rows. */
const SYNONYMS: Readonly<Record<string, string>> = { esc: 'escape', return: ENTER_KEY }

/** A bare letter or digit needs no name to be a key. */
const ALPHANUMERIC = /^[a-z0-9]$/u

/**
 * The base keys the library can name, lowercased, mapped to the library's own
 * spelling.
 *
 * Read from the library's own helper object: a key the library adds or renames
 * is validated and printed the way the library spells it, with no second table
 * to drift.
 */
const BASE_KEYS: ReadonlyMap<string, string> = (() => {
  const keys = new Map<string, string>()
  for (const value of Object.values(Key)) {
    if (typeof value === 'string') keys.set(value.toLowerCase(), value)
  }
  for (const [alias, canonical] of Object.entries(SYNONYMS)) keys.set(alias, canonical)
  return keys
})()

/**
 * One written key as the library's own canonical id, or undefined when the
 * terminal could never report it as a single press.
 *
 * Modifiers are folded into one order and the key is folded to the library's
 * spelling, because two spellings of one key would otherwise let two actions
 * claim the same press.
 */
export function normalizeKey(raw: string): KeyId | undefined {
  const parts = raw.trim().toLowerCase().split('+')
  const key = parts.pop()
  if (key === undefined || key === '') return undefined
  const base = BASE_KEYS.get(key)
  if (base === undefined && !ALPHANUMERIC.test(key)) return undefined
  const written: string[] = []
  const seen = new Set<string>()
  for (const part of parts) {
    // A repeat is not a chord the terminal reports, so it is a typo rather than a binding.
    if (!MODIFIERS.has(part) || seen.has(part)) return undefined
    seen.add(part)
    written.push(part)
  }
  written.sort((left, right) => MODIFIER_ORDER.indexOf(left as never) - MODIFIER_ORDER.indexOf(right as never))
  return [...written, base ?? key].join('+') as KeyId
}

const PROMPT_ACTIONS: readonly Action[] = [
  {
    id: 'prompt.submit',
    layer: 'prompt',
    defaultKeys: ['ctrl+enter', 'alt+enter', 'ctrl+s'],
    label: 'submit the prompt',
    mayUseBare: false,
    mayUnbind: false,
  },
  {
    id: 'prompt.newLine',
    layer: 'prompt',
    defaultKeys: [ENTER_KEY, 'shift+enter', 'ctrl+j'],
    label: 'break the line',
    mayUseBare: false,
    mayUnbind: false,
  },
]

/** The surface's own actions, each named as the handler map names it. */
export const SURFACE_ACTIONS: readonly (Action & { readonly name: SurfaceActionId })[] = [
  { id: 'surface.toolDetail', name: 'toolDetail', layer: 'surface', defaultKeys: ['ctrl+o'], label: 'tool detail', mayUseBare: false, mayUnbind: false },
  { id: 'surface.subCalls', name: 'subCalls', layer: 'surface', defaultKeys: ['ctrl+y'], label: 'nested calls', mayUseBare: false, mayUnbind: false },
  { id: 'surface.reasoning', name: 'reasoning', layer: 'surface', defaultKeys: ['shift+tab'], label: 'reasoning', mayUseBare: false, mayUnbind: false },
  { id: 'surface.effort', name: 'effort', layer: 'surface', defaultKeys: ['ctrl+t'], label: 'reasoning effort', mayUseBare: false, mayUnbind: false },
  { id: 'surface.history', name: 'history', layer: 'surface', defaultKeys: ['ctrl+r'], label: 'search prompt history', mayUseBare: false, mayUnbind: false },
  { id: 'surface.back', name: 'back', layer: 'surface', defaultKeys: ['ctrl+b'], label: 'back to this session', mayUseBare: false, mayUnbind: false },
  { id: 'surface.interrupt', name: 'interrupt', layer: 'surface', defaultKeys: ['ctrl+c'], label: 'interrupt or exit', mayUseBare: false, mayUnbind: false },
]

const CHORD_ACTIONS: readonly Action[] = [
  { id: 'chord.prefix', layer: 'chord', defaultKeys: ['ctrl+x'], label: 'start a chord', mayUseBare: false, mayUnbind: false, keyShape: 'chord' },
  { id: 'chord.model', layer: 'chord', defaultKeys: ['m'], label: 'model', mayUseBare: true, mayUnbind: false },
  { id: 'chord.plan', layer: 'chord', defaultKeys: ['p'], label: 'plan mode', mayUseBare: true, mayUnbind: false },
  { id: 'chord.copy', layer: 'chord', defaultKeys: ['y'], label: 'copy', mayUseBare: true, mayUnbind: false },
  { id: 'chord.stash', layer: 'chord', defaultKeys: ['s'], label: 'stash the draft', mayUseBare: true, mayUnbind: false },
  { id: 'chord.stashes', layer: 'chord', defaultKeys: ['l'], label: 'stashed drafts', mayUseBare: true, mayUnbind: false },
  { id: 'chord.editor', layer: 'chord', defaultKeys: ['e'], label: 'external editor', mayUseBare: true, mayUnbind: false },
]

const GATE_ACTIONS: readonly Action[] = [
  { id: 'gate.allow', layer: 'gate', defaultKeys: ['y'], label: 'allow once', mayUseBare: true, mayUnbind: false },
  { id: 'gate.reject', layer: 'gate', defaultKeys: ['n'], label: 'reject', mayUseBare: true, mayUnbind: false },
  { id: 'gate.cancel', layer: 'gate', defaultKeys: ['escape'], label: 'cancel', mayUseBare: false, mayUnbind: false },
]

const QUESTION_ACTIONS: readonly Action[] = [
  { id: 'question.up', layer: 'question', defaultKeys: ['up'], label: 'previous option', mayUseBare: false, mayUnbind: false },
  { id: 'question.down', layer: 'question', defaultKeys: ['down'], label: 'next option', mayUseBare: false, mayUnbind: false },
  { id: 'question.toggle', layer: 'question', defaultKeys: ['space'], label: 'toggle an option', mayUseBare: false, mayUnbind: false },
  { id: 'question.confirm', layer: 'question', defaultKeys: [ENTER_KEY], label: 'answer the question', mayUseBare: false, mayUnbind: false },
  { id: 'question.skip', layer: 'question', defaultKeys: ['escape'], label: 'skip this question', mayUseBare: false, mayUnbind: false },
]

const PICKER_ACTIONS: readonly Action[] = [
  { id: 'picker.up', layer: 'picker', defaultKeys: ['up'], label: 'previous row', mayUseBare: false, mayUnbind: false },
  { id: 'picker.down', layer: 'picker', defaultKeys: ['down'], label: 'next row', mayUseBare: false, mayUnbind: false },
  { id: 'picker.confirm', layer: 'picker', defaultKeys: [ENTER_KEY], label: 'take the row', mayUseBare: false, mayUnbind: false },
  { id: 'picker.cancel', layer: 'picker', defaultKeys: ['escape', 'ctrl+c'], label: 'leave the list', mayUseBare: false, mayUnbind: false },
]

/**
 * Library ids whose meaning this surface owns.
 *
 * The prompt bar reads both through its own actions, because it adds a guard
 * the library cannot know: Enter is a line break unless a completion menu is
 * open, and a terminal that cannot report alt+enter spells it as a sequence the
 * library reads as a newline. Writing the library's spelling is refused with a
 * pointer at the action that does own it.
 */
export const KEYMAP_ALIASES: Readonly<Record<string, string>> = {
  'tui.input.submit': 'prompt.submit',
  'tui.input.newLine': 'prompt.newLine',
}

/** The library's own actions, read from the library rather than restated. */
function libraryActions(): readonly Action[] {
  return Object.entries(TUI_KEYBINDINGS)
    .filter(([id]) => KEYMAP_ALIASES[id] === undefined)
    .map(([id, definition]) => {
      const defaults = Array.isArray(definition.defaultKeys) ? definition.defaultKeys : [definition.defaultKeys]
      return {
        id,
        layer: 'library' as const,
        defaultKeys: defaults.map(key => normalizeKey(key)).filter((key): key is KeyId => key !== undefined),
        label: definition.description,
        mayUseBare: false,
        // Only a key the library ships unbound may be emptied: every other row
        // is one the reader would otherwise have to remember a command for.
        mayUnbind: defaults.length === 0,
      }
    })
}

/** Every action a reader may bind. */
export const ACTION_CATALOG: readonly Action[] = [
  ...PROMPT_ACTIONS,
  ...SURFACE_ACTIONS,
  ...CHORD_ACTIONS,
  ...GATE_ACTIONS,
  ...QUESTION_ACTIONS,
  ...PICKER_ACTIONS,
  ...libraryActions(),
]

/**
 * Whether the library can match a key at all.
 *
 * The library answers no modifier on Escape or on a function key, because no
 * terminal reports those, and no modifier beyond plain, shift, and control on
 * Clear. A binding there would be a key the reader could never press.
 */
function isPressable(key: KeyId): boolean {
  const parts = key.split('+')
  const base = parts.pop() ?? ''
  const count = parts.length
  if (base === 'escape' && count > 0) return false
  if (/^f([1-9]|1[0-2])$/u.test(base) && count > 0) return false
  if (base === 'clear' && (count > 1 || parts.includes('alt') || parts.includes('super'))) return false
  return true
}

/** Whether a key is one modifier chord on one letter or digit, the only shape a chord starter may take. */
function isSimpleChord(key: KeyId): boolean {
  const base = key.split('+').pop() ?? ''
  return key.includes('+') && /^[a-z0-9]$/u.test(base)
}

/**
 * Whether a key is a character the reader types, which only an armed layer may take.
 *
 * Shift is not a way out of this: a terminal reports a capital letter as the
 * shifted letter, so shift+c types a C wherever c does.
 */
function isBareCharacter(key: KeyId): boolean {
  const bare = key.startsWith('shift+') ? key.slice('shift+'.length) : key
  if (bare.includes('+')) return false
  return bare === 'space' || (bare.length === 1 && bare >= ' ')
}

/** What the settings document may say about one action: one key, or a list of them. */
export type KeyListValue = string | readonly string[] | undefined

/** The reader's raw `keys:` section. */
export type KeymapOverrides = Readonly<Record<string, KeyListValue>>

/** Every action's effective keys, and which of them the reader wrote. */
export interface Keymap {
  readonly effective: Readonly<Record<string, readonly KeyId[]>>
  readonly written: ReadonlySet<string>
}

/** One key a reader wrote, over the layer that would otherwise answer it. */
export interface Shadow {
  readonly key: KeyId
  readonly winner: string
  readonly loser: string
}

function actionOf(id: string): Action | undefined {
  return ACTION_CATALOG.find(entry => entry.id === id)
}

/** The keys in force for one action, or nothing when no action has that id. */
export function keysFor(map: Keymap, id: string): readonly KeyId[] {
  return map.effective[id] ?? []
}

/** Whether a press is one of the keys in force for an action. */
export function matchesAction(map: Keymap, id: string, data: string): boolean {
  return keysFor(map, id).some(key => matchesKey(data, key))
}

/**
 * The name a hint prints for a key.
 *
 * A hint is a line of prose in a card, so the names a terminal already writes on
 * its own keycaps win over the library's spelling of them.
 */
const SHORT_KEY_NAMES: Readonly<Record<string, string>> = { escape: 'esc' }

export function keyName(key: KeyId): string {
  return SHORT_KEY_NAMES[key] ?? key
}

/**
 * The keys that move a cursor, as a hint prints them.
 *
 * A terminal draws arrows on its keycaps, which is shorter than the names the
 * library uses; a map that moved them falls back to naming whatever it moved
 * them to, because a glyph for a key nobody has would be a lie.
 */
export function moveHint(map: Keymap, upId: string, downId: string): string {
  const up = keysFor(map, upId).map(keyName)
  const down = keysFor(map, downId).map(keyName)
  if (up.length === 1 && up[0] === 'up' && down.length === 1 && down[0] === 'down') return '↑↓'
  return `${up.join('/')} or ${down.join('/')}`
}

/** How an action names itself in a hint. */
export function actionLabel(id: string): string {
  return actionOf(id)?.label ?? id
}

/**
 * The keys in force for one action, as a hint prints them.
 *
 * One word for the action however many keys reach it, so a hint does not read
 * as two actions. Read from the live map, because a hint drawn after a settings
 * edit must not keep advertising the key the reader just moved.
 */
export function hintKeys(map: Keymap, id: string): string {
  return keysFor(map, id).map(keyName).join('/')
}

function readKeys(action: Action, value: string | readonly string[]): readonly KeyId[] {
  const written = Array.isArray(value) ? value : [value]
  const keys: KeyId[] = []
  for (const raw of written) {
    const key = normalizeKey(raw)
    if (key === undefined) throw new Error(`key "${raw}" on ${action.id} is not a key a terminal reports`)
    if (TERMINAL_OWNED_KEYS.includes(key)) throw new Error(`key "${key}" on ${action.id} is the terminal's own key`)
    // A row's own shipped key is always writable: a document that spells out the
    // default changes nothing, and refusing it would cost the reader the section.
    if (!action.mayUseBare && isBareCharacter(key) && !action.defaultKeys.includes(key)) {
      throw new Error(`key "${key}" on ${action.id} would be typed rather than commanded; write a modifier chord or a named key`)
    }
    if (action.keyShape === 'chord' && !isSimpleChord(key)) {
      throw new Error(`key "${key}" on ${action.id} must be a modifier chord like ctrl+x`)
    }
    if (!isPressable(key)) {
      throw new Error(`key "${key}" on ${action.id} is one the library never matches; write a key the terminal reports`)
    }
    // A repeat inside one list is the same press written twice, not a second key.
    if (!keys.includes(key)) keys.push(key)
  }
  if (keys.length === 0 && !action.mayUnbind) {
    throw new Error(`${action.id} needs at least one key; the surface has no other way to do it`)
  }
  return keys
}

/** How many single-byte presses a probe walks: every byte a terminal can send on its own. */
const PROBE_BYTES = 0x80

/**
 * The sequences one press can arrive as, so an overlap is read from the matcher.
 *
 * The library is the only authority on which sequences are one press, and its
 * reading is looser than a spelling table could say: a bare terminal reports
 * Return for both Enter and Ctrl+M, one control byte carries Ctrl+- and Ctrl+_
 * alike, and escape-prefixed bytes reach more than one alt key — an escape and a
 * letter answers Alt+Up as well as Alt+P. Both protocol modes are read over the
 * same bytes, because a terminal without the protocol folds spellings together
 * that one with it keeps apart. The answer is cached: which sequences reach a key
 * is a property of the key rather than of the map.
 */
const PRESS_PROBES: readonly string[] = Array.from(
  { length: PROBE_BYTES },
  (_, code) => String.fromCharCode(code),
).flatMap(byte => [byte, `\u001b${byte}`])

/** One sequence named so two rows can agree on it without carrying the bytes. */
function spellingOf(sequence: string): string {
  return `seq:${[...sequence].map(character => character.charCodeAt(0).toString(16)).join('-')}`
}

const pressSpellings = new Map<string, readonly string[]>()

/** The sequences that reach a key in either protocol mode, or its own id when none does. */
function matchPresses(key: KeyId): readonly string[] {
  const cached = pressSpellings.get(key)
  if (cached !== undefined) return cached
  const spelled = new Set<string>()
  const wasKitty = isKittyProtocolActive()
  try {
    for (const kitty of [false, true]) {
      setKittyProtocolActive(kitty)
      for (const probe of PRESS_PROBES) {
        if (matchesKey(probe, key)) spelled.add(spellingOf(probe))
      }
    }
  } finally {
    setKittyProtocolActive(wasKitty)
  }
  const answer: readonly string[] = spelled.size === 0 ? [`key:${key}`] : [...spelled]
  pressSpellings.set(key, answer)
  return answer
}

/** One row as a press table reads it: what answers a press, and the key it was written as. */
interface PressRow {
  readonly id: string
  readonly key: KeyId
}

/** A press more than one row reads: the rows, one spelling of it, and the sequences they share. */
interface PressOverlap {
  readonly ids: readonly string[]
  readonly key: KeyId
  readonly spellings: readonly string[]
}

/**
 * Group the rows one terminal sequence reaches, so a group is a press that cannot
 * be split between them.
 */
function pressOverlaps(rows: readonly PressRow[]): PressOverlap[] {
  const rowAt = (index: number): PressRow => rows[index]!
  const reached = new Map<string, number[]>()
  rows.forEach((row, index) => {
    for (const spelling of matchPresses(row.key)) {
      const found = reached.get(spelling) ?? []
      if (!found.includes(index)) found.push(index)
      reached.set(spelling, found)
    }
  })
  const parent = rows.map((_, index) => index)
  const find = (index: number): number => {
    const kept = parent[index] ?? index
    if (kept === index) return index
    const root = find(kept)
    parent[index] = root
    return root
  }
  for (const indexes of reached.values()) {
    for (const index of indexes.slice(1)) {
      const left = find(indexes[0]!)
      const right = find(index)
      if (left !== right) parent[right] = left
    }
  }
  const groups = new Map<number, number[]>()
  rows.forEach((_, index) => {
    const root = find(index)
    const found = groups.get(root) ?? []
    found.push(index)
    groups.set(root, found)
  })
  const overlaps: PressOverlap[] = []
  for (const found of groups.values()) {
    const ids = [...new Set(found.map(index => rowAt(index).id))].sort()
    if (ids.length < 2) continue
    // A spelling counts as shared only when two different rows read it: one row
    // may hold two spellings of the same press (Return beside Ctrl+M), which is
    // the reader saying one thing rather than a press two rows fight over.
    const spellings = [...new Set(found.flatMap(index => matchPresses(rowAt(index).key)))]
      .filter(spelling => new Set(
        (reached.get(spelling) ?? []).filter(index => found.includes(index)).map(index => rowAt(index).id),
      ).size > 1)
      .sort()
    overlaps.push({ ids, key: rowAt(found[0]!).key, spellings })
  }
  return overlaps
}

/**
 * Refuse two actions of one layer a terminal cannot tell apart.
 *
 * Layers are checked apart because sharing across them is the design: the chord
 * layer takes a key before the surface answers it, and the surface takes one
 * before the library's editor sees it. Within one layer a shared press is an
 * action the reader could never reach — and the surface answers these layers
 * itself, first row first, so two rows sharing one byte is one row that loses.
 */
function refuseMatcherClashes(effective: Readonly<Record<string, readonly KeyId[]>>): void {
  for (const layer of ['surface', 'chord', 'gate', 'question', 'picker'] as const) {
    const rows: PressRow[] = []
    for (const action of ACTION_CATALOG) {
      if (action.layer !== layer) continue
      for (const key of effective[action.id] ?? []) rows.push({ id: action.id, key })
    }
    const overlap = pressOverlaps(rows)[0]
    if (overlap !== undefined) {
      throw new Error(`key "${overlap.key}" is bound to both ${overlap.ids.join(' and ')}`)
    }
  }
}

/**
 * Refuse two prompt rows claiming one press.
 *
 * The bar is the one layer the library's matcher does not decide: Return is
 * answered in the bar itself, which reads a line feed as send when the reader
 * bound it and as a line otherwise. Its rows are therefore compared by the
 * press they arrive as rather than by every byte the matcher folds, so moving
 * send onto Ctrl+J stays possible.
 */
function refusePromptClashes(effective: Readonly<Record<string, readonly KeyId[]>>): void {
  const owner = new Map<string, string>()
  for (const action of ACTION_CATALOG) {
    if (action.layer !== 'prompt') continue
    for (const key of effective[action.id] ?? []) {
      const press = pressOf(key)
      const taken = owner.get(press)
      if (taken !== undefined && taken !== action.id) {
        throw new Error(`key "${key}" is bound to both ${taken} and ${action.id}`)
      }
      owner.set(press, action.id)
    }
  }
}

/**
 * Refuse a chord starter that would take a key the surface already answers.
 *
 * The prefix is consumed before anything else looks at the press, so a starter
 * that is also a surface key would not shadow that action while a chord is
 * armed: it would remove it for the whole session.
 */
function refusePrefixTakingKeys(effective: Readonly<Record<string, readonly KeyId[]>>): void {
  const owners = ACTION_CATALOG.filter(action => action.layer === 'surface' || action.layer === 'prompt')
  for (const key of effective['chord.prefix'] ?? []) {
    for (const owner of owners) {
      // A prefix is consumed before anything else looks at the press, so it takes
      // the key from a row that reads the same press under another spelling too.
      if ((effective[owner.id] ?? []).some(owned => pressOf(owned) === pressOf(key))) {
        throw new Error(`key "${key}" as chord.prefix would take it from ${owner.id}`)
      }
    }
  }
}

/**
 * The rows the library reads, as one map.
 *
 * Every library action appears, wherever the key came from, because a moved row
 * and an untouched default are read by the same matcher. The bar's two actions
 * are here as well: they are installed even when the reader never wrote them, so
 * they share the keyboard with the library's own rows.
 */
function libraryRows(effective: Readonly<Record<string, readonly KeyId[]>>): Record<string, KeyId[]> {
  const rows: Record<string, KeyId[]> = {}
  for (const action of ACTION_CATALOG) {
    if (action.layer === 'library') rows[action.id] = [...(effective[action.id] ?? [])]
  }
  rows['tui.input.submit'] = [...(effective['prompt.submit'] ?? [])]
  // Enter is left out of the installation for one reason and kept here for the
  // opposite one: the library reads that press as a line break before it looks
  // for this row, so a library row that took Return would be the row that never
  // runs while the bar still answers it — as a line, or as send.
  const line = effective['prompt.newLine'] ?? []
  rows['tui.input.newLine'] = line.includes(ENTER_KEY) ? [...line] : line.filter(key => key !== ENTER_KEY)
  return rows
}

/** The same rows as they read before the reader wrote anything. */
function shippedLibraryRows(): Record<string, KeyId[]> {
  const defaults = new Map(ACTION_CATALOG.map(action => [action.id, action.defaultKeys]))
  const rows: Record<string, KeyId[]> = {}
  for (const action of ACTION_CATALOG) {
    if (action.layer === 'library') rows[action.id] = [...action.defaultKeys]
  }
  rows['tui.input.submit'] = [...(defaults.get('prompt.submit') ?? [])]
  rows['tui.input.newLine'] = [...(defaults.get('prompt.newLine') ?? [])]
  return rows
}

/**
 * The component that reads a library row.
 *
 * Two rows one component reads can fight over a press. Rows of different
 * components meet only where the library already ships the overlap, such as the
 * viewport's page keys shadowing the editor's, so those are its business rather
 * than a clash to refuse.
 */
function libraryComponent(id: string): string {
  if (id.startsWith('tui.editor.') || id.startsWith('tui.input.')) return 'editor'
  if (id.startsWith('tui.select.')) return 'select'
  if (id.startsWith('tui.altScreen.')) return 'viewport'
  return 'other'
}

/** Every press one component reads on more than one row, with the rows that read it. */
function sharedPresses(rows: Readonly<Record<string, readonly KeyId[]>>): Map<string, string[]> {
  const owners = new Map<string, Map<string, string[]>>()
  for (const [id, keys] of Object.entries(rows)) {
    const component = libraryComponent(id)
    for (const key of keys) {
      const press = pressOf(key)
      const byComponent = owners.get(press) ?? new Map<string, string[]>()
      const found = byComponent.get(component) ?? []
      if (!found.includes(id)) found.push(id)
      byComponent.set(component, found)
      owners.set(press, byComponent)
    }
  }
  const shared = new Map<string, string[]>()
  for (const [press, byComponent] of owners) {
    for (const ids of byComponent.values()) {
      if (ids.length > 1) shared.set(press, [...ids].sort())
    }
  }
  return shared
}

/**
 * The overlaps the library's own rows carry, one component at a time.
 *
 * The bar's own two rows are left out: they are read by the bar before the
 * library's matcher runs, so a line feed is send when the reader bound it and a
 * line otherwise, and comparing them by every sequence the matcher folds would
 * forbid a choice the bar can honour.
 */
function libraryOverlaps(rows: Readonly<Record<string, readonly KeyId[]>>): PressOverlap[] {
  const overlaps: PressOverlap[] = []
  for (const component of ['editor', 'select', 'viewport', 'other'] as const) {
    const own: PressRow[] = []
    for (const [id, keys] of Object.entries(rows)) {
      if (id === 'tui.input.submit' || id === 'tui.input.newLine') continue
      if (libraryComponent(id) !== component) continue
      for (const key of keys) own.push({ id, key })
    }
    overlaps.push(...pressOverlaps(own))
  }
  return overlaps
}

/** What makes two overlaps the same fight: the rows, and the sequences they share. */
function overlapIdentity(overlap: PressOverlap): string {
  return `${overlap.ids.join(',')}\u0000${overlap.spellings.join('|')}`
}

/**
 * Refuse two rows the library reads on one press.
 *
 * The library's own manager reports a clash between rows the reader wrote and
 * nothing else, which would let a new binding quietly take a key from a row the
 * reader never touched. Rows are compared twice: by the press they were written
 * as, which is what the bar's own rows are matched by, and by every sequence the
 * matcher folds, which is what catches one control byte carrying two spellings.
 * The overlaps the library itself ships are left alone: those are rows it
 * already knows how to tell apart.
 */
function refuseLibraryClashes(effective: Readonly<Record<string, readonly KeyId[]>>): void {
  const shipped = new Set([...sharedPresses(shippedLibraryRows())].map(([press, ids]) => `${press}\u0000${ids.join(',')}`))
  for (const [press, ids] of sharedPresses(libraryRows(effective))) {
    if (shipped.has(`${press}\u0000${ids.join(',')}`)) continue
    throw new Error(`key "${press}" is bound to both ${ids.join(' and ')}; move one of them or pick another key`)
  }
  const shippedOverlaps = new Set(libraryOverlaps(shippedLibraryRows()).map(overlapIdentity))
  for (const overlap of libraryOverlaps(libraryRows(effective))) {
    if (shippedOverlaps.has(overlapIdentity(overlap))) continue
    throw new Error(`key "${overlap.key}" is bound to both ${overlap.ids.join(' and ')}; move one of them or pick another key`)
  }
}

/**
 * The library rows that read a press before the surface's own listener runs.
 *
 * The alternate screen registers its viewport listener while the terminal is
 * built, so its keys arrive before a listener the surface adds later. These rows
 * are read without asking whether an overlay holds the keyboard; the search
 * overlay's own next, previous, and close keys are left out because they wait
 * for it and would let an overlay-scoped surface key through.
 */
const VIEWPORT_FIRST_ROWS: readonly string[] = [
  'tui.altScreen.search',
  'tui.altScreen.pageUp',
  'tui.altScreen.pageDown',
  'tui.altScreen.halfPageUp',
  'tui.altScreen.halfPageDown',
  'tui.altScreen.lineUp',
  'tui.altScreen.lineDown',
  'tui.altScreen.previousPrompt',
  'tui.altScreen.nextPrompt',
  'tui.altScreen.top',
  'tui.altScreen.bottom',
]

/** Every row a press reaches, with the keys in force: the catalog and the bar's own library rows. */
function dispatchRows(effective: Readonly<Record<string, readonly KeyId[]>>): Record<string, KeyId[]> {
  const rows: Record<string, KeyId[]> = {}
  for (const action of ACTION_CATALOG) rows[action.id] = [...(effective[action.id] ?? [])]
  rows['tui.input.submit'] = [...(effective['prompt.submit'] ?? [])]
  rows['tui.input.newLine'] = (effective['prompt.newLine'] ?? []).filter(key => key !== ENTER_KEY)
  return rows
}

/** The same rows as they read before the reader wrote anything. */
function shippedRows(): Record<string, KeyId[]> {
  const rows: Record<string, KeyId[]> = {}
  for (const action of ACTION_CATALOG) rows[action.id] = [...action.defaultKeys]
  rows['tui.input.submit'] = [...(actionOf('prompt.submit')?.defaultKeys ?? [])]
  rows['tui.input.newLine'] = [...(actionOf('prompt.newLine')?.defaultKeys ?? [])].filter(key => key !== ENTER_KEY)
  return rows
}

/** One press, the viewport row that reads it first, and a row that would never see it. */
interface ViewportPair {
  readonly key: KeyId
  readonly spellings: readonly string[]
  readonly viewport: string
  readonly other: string
}

function viewportPairs(rows: Readonly<Record<string, readonly KeyId[]>>): ViewportPair[] {
  const table: PressRow[] = []
  for (const [id, keys] of Object.entries(rows)) {
    for (const key of keys) table.push({ id, key })
  }
  const pairs: ViewportPair[] = []
  for (const overlap of pressOverlaps(table)) {
    const viewport = overlap.ids.filter(id => VIEWPORT_FIRST_ROWS.includes(id))
    for (const row of viewport) {
      for (const other of overlap.ids.filter(id => id !== row && !VIEWPORT_FIRST_ROWS.includes(id))) {
        pairs.push({ key: overlap.key, spellings: overlap.spellings, viewport: row, other })
      }
    }
  }
  return pairs
}

/**
 * Refuse a pair the viewport answers before the row it was written on.
 *
 * A key the alternate screen's listener reads never reaches the surface: the
 * press scrolls or searches instead, and the binding only looks alive while an
 * overlay defers the viewport. Either side of the pair can be the one the
 * reader wrote, and both are a binding that does nothing, so both are refused
 * apart from the overlap the library already ships.
 */
function refuseViewportTakingKeys(effective: Readonly<Record<string, readonly KeyId[]>>, written: ReadonlySet<string>): void {
  const pairKey = (pair: ViewportPair): string => `${pair.viewport}\u0000${pair.other}\u0000${pair.spellings.join('|')}`
  const shipped = new Set(viewportPairs(shippedRows()).map(pairKey))
  // A prompt row is read through a library row of the bar's own, so the reader's
  // name for the row is the action they wrote rather than the mirror.
  const isWritten = (id: string): boolean =>
    written.has(id) ||
    (id === 'tui.input.submit' && written.has('prompt.submit')) ||
    (id === 'tui.input.newLine' && written.has('prompt.newLine'))
  for (const pair of viewportPairs(dispatchRows(effective))) {
    if (shipped.has(pairKey(pair))) continue
    if (isWritten(pair.other)) {
      throw new Error(`key "${pair.key}" on ${pair.other} is read by ${pair.viewport} first; move that row or pick another key`)
    }
    if (isWritten(pair.viewport)) {
      throw new Error(`key "${pair.key}" on ${pair.viewport} would take it from ${pair.other}, which never sees the press; pick another key`)
    }
  }
}

/**
 * The reader's map over the shipped one.
 *
 * Every refusal names the action or the key that caused it, because a settings
 * document is edited by hand: a message the reader cannot act on is a message
 * that costs them the whole section.
 */
export function resolveKeymap(overrides: KeymapOverrides): Keymap {
  const effective: Record<string, readonly KeyId[]> = {}
  for (const action of ACTION_CATALOG) effective[action.id] = [...action.defaultKeys]
  const written = new Set<string>()
  for (const [id, value] of Object.entries(overrides)) {
    if (value === undefined) continue
    const canonical = KEYMAP_ALIASES[id]
    if (canonical !== undefined) throw new Error(`key action "${id}" belongs to the prompt bar; write ${canonical} instead`)
    const action = actionOf(id)
    if (action === undefined) throw new Error(`unknown dsh-tui key action: ${id}`)
    effective[id] = readKeys(action, value)
    written.add(id)
  }
  refusePromptClashes(effective)
  refuseMatcherClashes(effective)
  refusePrefixTakingKeys(effective)
  refuseLibraryClashes(effective)
  refuseViewportTakingKeys(effective, written)
  return { effective, written }
}

/** The map as it reads when the reader has written nothing, built once. */
export function defaultKeymap(): Keymap {
  // Read on every press by components that outlive a settings edit, so the
  // shipped map is resolved once rather than a row at a time on each key.
  shippedMap ??= resolveKeymap({})
  return shippedMap
}

let shippedMap: Keymap | undefined

const WINNING_LAYERS: readonly ActionLayer[] = ['chord', 'surface']

/** Every key the chord or surface layer takes from a library action, in layer order. */
export function shadowsOf(map: Keymap): readonly Shadow[] {
  const library = ACTION_CATALOG.filter(action => action.layer === 'library')
  const found: Shadow[] = []
  for (const layer of WINNING_LAYERS) {
    for (const winner of ACTION_CATALOG.filter(action => action.layer === layer)) {
      for (const key of keysFor(map, winner.id)) {
        for (const loser of library) {
          if (keysFor(map, loser.id).includes(key)) found.push({ key, winner: winner.id, loser: loser.id })
        }
      }
    }
  }
  return found
}

function shadowId(shadow: Shadow): string {
  return `${shadow.key} ${shadow.winner} ${shadow.loser}`
}

/**
 * The shadows a reader's map introduces, beyond the ones the surface ships with.
 *
 * Only the new ones: reporting the shipped map's own overlaps on every session
 * would teach the reader to ignore the line that matters.
 */
export function newShadows(map: Keymap): readonly Shadow[] {
  const shipped = new Set(shadowsOf(defaultKeymap()).map(shadowId))
  return shadowsOf(map).filter(shadow => !shipped.has(shadowId(shadow)))
}

/** One key the surface answers itself, in the order the catalog lists them. */
export interface SurfaceBinding {
  readonly key: KeyId
  readonly action: SurfaceActionId
  readonly id: string
}

/** Every key the surface's own listener answers, in catalog order. */
export function surfaceBindings(map: Keymap): readonly SurfaceBinding[] {
  const found: SurfaceBinding[] = []
  for (const action of SURFACE_ACTIONS) {
    for (const key of keysFor(map, action.id)) found.push({ key, action: action.name, id: action.id })
  }
  return found
}
