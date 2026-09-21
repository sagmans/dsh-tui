import { Key, KeybindingsManager, TUI_KEYBINDINGS, matchesKey, type KeyId } from '@earendil-works/pi-tui'

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
export type SurfaceActionId = 'toolDetail' | 'subCalls' | 'reasoning' | 'effort' | 'back' | 'interrupt'

/** A key the tty answers before the application sees it. */
export const TERMINAL_OWNED_KEYS: readonly KeyId[] = ['ctrl+q']

/** The key a plain press of Return arrives as. */
export const ENTER_KEY: KeyId = 'enter'

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
  { id: 'surface.back', name: 'back', layer: 'surface', defaultKeys: ['ctrl+b'], label: 'back to this session', mayUseBare: false, mayUnbind: false },
  { id: 'surface.interrupt', name: 'interrupt', layer: 'surface', defaultKeys: ['ctrl+c'], label: 'interrupt or exit', mayUseBare: false, mayUnbind: false },
]

const CHORD_ACTIONS: readonly Action[] = [
  { id: 'chord.prefix', layer: 'chord', defaultKeys: ['ctrl+x'], label: 'start a chord', mayUseBare: false, mayUnbind: false, keyShape: 'chord' },
  { id: 'chord.model', layer: 'chord', defaultKeys: ['m'], label: 'model', mayUseBare: true, mayUnbind: false },
  { id: 'chord.plan', layer: 'chord', defaultKeys: ['p'], label: 'plan mode', mayUseBare: true, mayUnbind: false },
  { id: 'chord.copy', layer: 'chord', defaultKeys: ['y'], label: 'copy', mayUseBare: true, mayUnbind: false },
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

/** Whether a key is one modifier chord on one letter or digit, the only shape a chord starter may take. */
function isSimpleChord(key: KeyId): boolean {
  const base = key.split('+').pop() ?? ''
  return key.includes('+') && /^[a-z0-9]$/u.test(base)
}

/** Whether a key is a character the reader types, which only an armed layer may take. */
function isBareCharacter(key: KeyId): boolean {
  if (key.includes('+')) return false
  return key === 'space' || (key.length === 1 && key >= ' ')
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

function readKeys(action: Action, value: string | readonly string[]): readonly KeyId[] {
  const written = Array.isArray(value) ? value : [value]
  const keys: KeyId[] = []
  for (const raw of written) {
    const key = normalizeKey(raw)
    if (key === undefined) throw new Error(`key "${raw}" on ${action.id} is not a key a terminal reports`)
    if (TERMINAL_OWNED_KEYS.includes(key)) throw new Error(`key "${key}" on ${action.id} is the terminal's own key`)
    if (!action.mayUseBare && isBareCharacter(key)) {
      throw new Error(`key "${key}" on ${action.id} would be typed rather than commanded; write a modifier chord or a named key`)
    }
    if (action.keyShape === 'chord' && !isSimpleChord(key)) {
      throw new Error(`key "${key}" on ${action.id} must be a modifier chord like ctrl+x`)
    }
    // A repeat inside one list is the same press written twice, not a second key.
    if (!keys.includes(key)) keys.push(key)
  }
  if (keys.length === 0 && !action.mayUnbind) {
    throw new Error(`${action.id} needs at least one key; the surface has no other way to do it`)
  }
  return keys
}

/**
 * Refuse two actions of one layer claiming one press.
 *
 * Layers are checked apart because sharing across them is the design: the chord
 * layer takes a key before the surface answers it, and the surface takes one
 * before the library's editor sees it. Within one layer a shared key is an
 * action the reader could never reach.
 */
function refuseLayerClashes(effective: Readonly<Record<string, readonly KeyId[]>>): void {
  for (const layer of ['prompt', 'surface', 'chord', 'gate', 'question', 'picker'] as const) {
    const owner = new Map<KeyId, string>()
    for (const action of ACTION_CATALOG) {
      if (action.layer !== layer) continue
      for (const key of effective[action.id] ?? []) {
        const taken = owner.get(key)
        if (taken !== undefined) throw new Error(`key "${key}" is bound to both ${taken} and ${action.id}`)
        owner.set(key, action.id)
      }
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
      if ((effective[owner.id] ?? []).includes(key)) {
        throw new Error(`key "${key}" as chord.prefix would take it from ${owner.id}`)
      }
    }
  }
}

/**
 * Refuse two library actions the reader bound to one key.
 *
 * Asked of the library's own manager rather than reimplemented, so the answer
 * matches what the reader will actually live with. A key the library ships on
 * two rows is not a clash: the rows belong to different components.
 */
function refuseLibraryClashes(effective: Readonly<Record<string, readonly KeyId[]>>, written: ReadonlySet<string>): void {
  const userBindings: Record<string, KeyId[]> = {}
  for (const id of written) {
    if (!id.startsWith('tui.')) continue
    userBindings[id] = [...(effective[id] ?? [])]
  }
  const conflict = new KeybindingsManager(TUI_KEYBINDINGS, userBindings).getConflicts()[0]
  if (conflict !== undefined) {
    throw new Error(`key "${conflict.key}" is bound to both ${conflict.keybindings.join(' and ')}`)
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
  refuseLayerClashes(effective)
  refusePrefixTakingKeys(effective)
  refuseLibraryClashes(effective, written)
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
