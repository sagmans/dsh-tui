import { type ActionLayer, type Action, type SurfaceActionId, SURFACE_ACTIONS, LIBRARY_KEY_ADDITIONS, KEYMAP_ALIASES, ACTION_CATALOG, actionOf, shippedKeys } from './action-catalog.ts'
import { TERMINAL_OWNED_KEYS, normalizeKey, isPressable, isSimpleChord, isBareCharacter } from './key-press.ts'
import { refuseMatcherClashes, refusePromptClashes, refusePrefixTakingKeys, refuseLibraryClashes, refuseViewportTakingKeys } from './keymap-conflicts.ts'
import { matchesKey, type KeyId } from '@earendil-works/pi-tui'

/**
 * The keymap a reader actually has, and the labels drawn from it.
 *
 * This is the layer above the catalog and the conflict policy: it resolves the
 * shipped map, then every override, into the effective binding per action, and
 * answers the display questions the surface asks about it.
 */

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

/** One movement key as a hint prints it: the keycap glyph where the terminal has one. */
const MOVE_GLYPHS: Readonly<Record<string, string>> = { up: '↑', down: '↓' }

/** The glyph for one key of a movement pair, or the key's own name where it has none. */
function moveName(key: string): string {
  return MOVE_GLYPHS[key] ?? key
}

/**
 * The keys that move a cursor, as a hint prints them.
 *
 * A terminal draws arrows on its keycaps, which is shorter than the names the
 * library uses; a map that moved them falls back to naming whatever it moved
 * them to, because a glyph for a key nobody has would be a lie. Each direction
 * keeps its own list: the aliases a reader adds are alternatives to one arrow
 * each, so pooling them would not say which way a key goes.
 */
export function moveHint(map: Keymap, upId: string, downId: string): string {
  const up = keysFor(map, upId).map(keyName)
  const down = keysFor(map, downId).map(keyName)
  if (up.length === 1 && up[0] === 'up' && down.length === 1 && down[0] === 'down') return '↑↓'
  return `${up.map(moveName).join('/')} or ${down.map(moveName).join('/')}`
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

/**
 * The reader's map over the shipped one.
 *
 * Every refusal names the action or the key that caused it, because a settings
 * document is edited by hand: a message the reader cannot act on is a message
 * that costs them the whole section.
 */
export function resolveKeymap(overrides: KeymapOverrides): Keymap {
  // An addition naming a row the library no longer draws would silently drop
  // the key, so it is refused while the startup still has somewhere to say so.
  for (const id of Object.keys(LIBRARY_KEY_ADDITIONS)) {
    if (actionOf(id)?.layer !== 'library') throw new Error(`key additions name ${id}, which is not a library action this surface can bind`)
  }
  const effective: Record<string, readonly KeyId[]> = {}
  for (const action of ACTION_CATALOG) effective[action.id] = [...shippedKeys(action)]
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
