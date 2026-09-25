import { ENTER_KEY, pressOf, type PressRow, type PressOverlap, pressOverlaps } from './key-press.ts'
import { ACTION_CATALOG, actionOf, shippedKeys } from './action-catalog.ts'
import { type KeyId } from '@earendil-works/pi-tui'

/**
 * Which bindings a keymap must refuse, and why.
 *
 * A reader may layer their own keys over the shipped ones, so the surface has
 * to decide which collisions are load-bearing rather than merely untidy; that
 * policy is kept out of both the action table and the press spellings it judges.
 */

/**
 * Refuse two actions of one layer a terminal cannot tell apart.
 *
 * Layers are checked apart because sharing across them is the design: the chord
 * layer takes a key before the surface answers it, and the surface takes one
 * before the library's editor sees it. Within one layer a shared press is an
 * action the reader could never reach — and the surface answers these layers
 * itself, first row first, so two rows sharing one byte is one row that loses.
 */
export function refuseMatcherClashes(effective: Readonly<Record<string, readonly KeyId[]>>): void {
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
export function refusePromptClashes(effective: Readonly<Record<string, readonly KeyId[]>>): void {
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
export function refusePrefixTakingKeys(effective: Readonly<Record<string, readonly KeyId[]>>): void {
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
    if (action.layer === 'library') rows[action.id] = [...shippedKeys(action)]
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
export function refuseLibraryClashes(effective: Readonly<Record<string, readonly KeyId[]>>): void {
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
  for (const action of ACTION_CATALOG) rows[action.id] = [...shippedKeys(action)]
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
export function refuseViewportTakingKeys(effective: Readonly<Record<string, readonly KeyId[]>>, written: ReadonlySet<string>): void {
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
