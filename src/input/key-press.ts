import { Key, isKittyProtocolActive, matchesKey, setKittyProtocolActive, type KeyId } from '@earendil-works/pi-tui'

/**
 * How a key press is spelled, matched, and compared across terminals.
 *
 * A binding is durable, but the bytes that reach the surface are not: this
 * layer owns the equivalences that make one press equal to another, separately
 * from the table of actions those presses resolve to.
 */

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

/**
 * Whether the library can match a key at all.
 *
 * The library answers no modifier on Escape or on a function key, because no
 * terminal reports those, and no modifier beyond plain, shift, and control on
 * Clear. A binding there would be a key the reader could never press.
 */
export function isPressable(key: KeyId): boolean {
  const parts = key.split('+')
  const base = parts.pop() ?? ''
  const count = parts.length
  if (base === 'escape' && count > 0) return false
  if (/^f([1-9]|1[0-2])$/u.test(base) && count > 0) return false
  if (base === 'clear' && (count > 1 || parts.includes('alt') || parts.includes('super'))) return false
  return true
}

/** Whether a key is one modifier chord on one letter or digit, the only shape a chord starter may take. */
export function isSimpleChord(key: KeyId): boolean {
  const base = key.split('+').pop() ?? ''
  return key.includes('+') && /^[a-z0-9]$/u.test(base)
}

/**
 * Whether a key is a character the reader types, which only an armed layer may take.
 *
 * Shift is not a way out of this: a terminal reports a capital letter as the
 * shifted letter, so shift+c types a C wherever c does.
 */
export function isBareCharacter(key: KeyId): boolean {
  const bare = key.startsWith('shift+') ? key.slice('shift+'.length) : key
  if (bare.includes('+')) return false
  return bare === 'space' || (bare.length === 1 && bare >= ' ')
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
export interface PressRow {
  readonly id: string
  readonly key: KeyId
}

/** A press more than one row reads: the rows, one spelling of it, and the sequences they share. */
export interface PressOverlap {
  readonly ids: readonly string[]
  readonly key: KeyId
  readonly spellings: readonly string[]
}

/**
 * Group the rows one terminal sequence reaches, so a group is a press that cannot
 * be split between them.
 */
export function pressOverlaps(rows: readonly PressRow[]): PressOverlap[] {
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
