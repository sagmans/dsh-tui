import { matchesKey } from '@earendil-works/pi-tui'
import type { StoredSession } from '../agent/history.ts'

/** One selectable row of the picker. */
export interface PickerRow {
  readonly label: string
  readonly description: string | undefined
  readonly current: boolean
}

/** How the picker presents itself, independent of how it is drawn. */
export interface PickerCard {
  readonly title: string
  readonly rows: readonly PickerRow[]
  readonly filter: string
  readonly hint: string
  /** Sessions above the window, so the reader knows the list continues. */
  readonly above: number
  /** Sessions below the window. */
  readonly below: number
}

/** What one key press asked the picker to do. */
export type PickerAction =
  | { readonly kind: 'pick'; readonly id: string }
  | { readonly kind: 'cancel' }

/**
 * Rows the picker shows at once.
 *
 * The card is drawn at the end of a viewport that follows the transcript, so a
 * list taller than the screen would push its own cursor out of sight. The
 * window stays around the cursor instead, and the counts say what is hidden.
 */
export const PICKER_WINDOW = 12

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** Human age of a session, so a list of ids becomes a list of moments. */
export function describeAge(createdAt: number, now: number): string {
  const elapsed = Math.max(0, now - createdAt)
  if (elapsed < MINUTE_MS) return 'just now'
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m ago`
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h ago`
  return `${Math.floor(elapsed / DAY_MS)}d ago`
}

/**
 * One stored session chosen by key press.
 *
 * The picker owns only what it shows: ids and rows come from the caller, and
 * the titles arrive after the list does, because reading every log before the
 * first paint would make opening the picker as slow as the slowest session.
 */
export class SessionPicker {
  private cursor = 0
  private filter = ''

  constructor(
    private readonly sessions: readonly StoredSession[],
    private readonly titles: () => ReadonlyMap<string, string>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Sessions matching the typed filter, in the order they were listed. */
  visible(): readonly StoredSession[] {
    const needle = this.filter.trim().toLowerCase()
    if (needle === '') return this.sessions
    return this.sessions.filter(session => this.haystack(session).includes(needle))
  }

  private haystack(session: StoredSession): string {
    return [this.titles().get(session.id) ?? '', session.id, session.cwd ?? ''].join(' ').toLowerCase()
  }

  private labelOf(session: StoredSession): string {
    return this.titles().get(session.id) ?? session.id
  }

  private descriptionOf(session: StoredSession): string {
    const parts = [session.cwd ?? 'unknown directory', describeAge(session.createdAt, this.now())]
    if (session.eventCount !== undefined) parts.push(`${session.eventCount} events`)
    return parts.join(' · ')
  }

  /** Apply one key press; returns an action only when the picker settles. */
  handleKey(data: string): PickerAction | undefined {
    const rows = this.visible()
    if (matchesKey(data, 'escape')) return { kind: 'cancel' }
    if (matchesKey(data, 'enter')) {
      const chosen = rows[Math.min(this.cursor, Math.max(0, rows.length - 1))]
      return chosen === undefined ? undefined : { kind: 'pick', id: chosen.id }
    }
    if (matchesKey(data, 'up')) {
      this.cursor = Math.max(0, this.cursor - 1)
      return undefined
    }
    if (matchesKey(data, 'down')) {
      this.cursor = Math.min(Math.max(0, rows.length - 1), this.cursor + 1)
      return undefined
    }
    if (matchesKey(data, 'backspace')) {
      this.filter = this.filter.slice(0, -1)
      this.cursor = 0
      return undefined
    }
    if (matchesKey(data, 'space')) {
      this.filter += ' '
      this.cursor = 0
      return undefined
    }
    if (data.length === 1 && data >= ' ') {
      this.filter += data
      this.cursor = 0
    }
    return undefined
  }

  card(): PickerCard {
    const rows = this.visible()
    const cursor = Math.min(this.cursor, Math.max(0, rows.length - 1))
    const start = Math.max(0, Math.min(cursor - Math.floor(PICKER_WINDOW / 2), rows.length - PICKER_WINDOW))
    const window = rows.slice(start, start + PICKER_WINDOW)
    return {
      title: `resume a session · ${this.sessions.length} stored`,
      rows: window.map((session, index) => ({
        label: this.labelOf(session),
        description: this.descriptionOf(session),
        current: start + index === cursor,
      })),
      above: start,
      below: Math.max(0, rows.length - start - window.length),
      filter: this.filter,
      hint: rows.length === 0
        ? 'nothing matches · backspace to widen · esc cancel'
        : '↑↓ move · enter open · esc cancel · type to filter',
    }
  }
}
