import { matchesKey } from '@earendil-works/pi-tui'
import type { StoredSession } from '../agent/history.ts'
import { describePreset, type PresetSummary } from '../agent/presets.ts'

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
  /** Rows above the window, so the reader knows the list continues. */
  readonly above: number
  /** Rows below the window. */
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

/** The hint lines a list uses when it is empty and when it holds rows. */
export interface PickerHints {
  readonly empty: string
  readonly listed: string
}

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
 * A filtered list the reader moves through by key.
 *
 * The list is the caller's and is re-read on every key and paint, so rows whose
 * text arrives late — a session title read from its log, a roster re-read after
 * a preset was authored — appear without rebuilding the picker. Windowing,
 * filtering, and the keys are the same whatever the rows mean, which is why
 * they live here once instead of in every list a terminal has to choose from.
 */
export class ListPicker<Row> {
  private cursor = 0
  private filter = ''

  constructor(
    private readonly source: () => readonly Row[],
    private readonly heading: () => string,
    /** The value a pick settles on. */
    private readonly idOf: (row: Row) => string,
    private readonly describe: (row: Row) => PickerRow,
    /** Extra text the filter matches besides the row's own label. */
    private readonly haystackOf: (row: Row) => string,
    private readonly hints: PickerHints,
  ) {}

  /** Rows matching the typed filter, in the order they were listed. */
  visible(): readonly Row[] {
    const needle = this.filter.trim().toLowerCase()
    if (needle === '') return this.source()
    return this.source().filter(row => this.haystackOf(row).toLowerCase().includes(needle))
  }

  /** Apply one key press; returns an action only when the picker settles. */
  handleKey(data: string): PickerAction | undefined {
    const rows = this.visible()
    if (matchesKey(data, 'escape')) return { kind: 'cancel' }
    if (matchesKey(data, 'enter')) {
      const chosen = rows[Math.min(this.cursor, Math.max(0, rows.length - 1))]
      return chosen === undefined ? undefined : { kind: 'pick', id: this.idOf(chosen) }
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
      title: this.heading(),
      rows: window.map((row, index) => ({
        ...this.describe(row),
        current: start + index === cursor,
      })),
      above: start,
      below: Math.max(0, rows.length - start - window.length),
      filter: this.filter,
      hint: rows.length === 0 ? this.hints.empty : this.hints.listed,
    }
  }
}

/**
 * One stored session chosen by key press.
 *
 * The picker owns only what it shows: ids and rows come from the caller, and
 * the titles arrive after the list does, because reading every log before the
 * first paint would make opening the picker as slow as the slowest session.
 */
export class SessionPicker extends ListPicker<StoredSession> {
  constructor(
    sessions: readonly StoredSession[],
    titles: () => ReadonlyMap<string, string>,
    now: () => number = () => Date.now(),
  ) {
    const labelOf = (session: StoredSession): string => titles().get(session.id) ?? session.id
    super(
      () => sessions,
      () => `resume a session · ${sessions.length} stored`,
      session => session.id,
      session => ({
        label: labelOf(session),
        description: [
          session.cwd ?? 'unknown directory',
          describeAge(session.createdAt, now()),
          ...session.eventCount === undefined ? [] : [`${session.eventCount} events`],
        ].join(' · '),
        // The card marks the row under the cursor, which the list decides.
        current: false,
      }),
      session => [labelOf(session), session.id, session.cwd ?? ''].join(' '),
      {
        empty: 'nothing matches · backspace to widen · esc cancel',
        listed: '↑↓ move · enter open · esc cancel · type to filter',
      },
    )
  }
}

/**
 * One agent preset chosen by key press.
 *
 * The roster is re-read on every paint, so a preset authored or deleted while
 * the picker is open is present or gone without reopening it.
 */
export class PresetPicker extends ListPicker<PresetSummary> {
  constructor(
    presets: () => readonly PresetSummary[],
    currentId: () => string | undefined,
  ) {
    super(
      presets,
      () => `agent preset · ${presets().length} available`,
      preset => preset.id,
      preset => describePreset(preset, currentId()),
      preset => [preset.id, preset.name ?? '', preset.description ?? ''].join(' '),
      {
        empty: 'nothing matches · backspace to widen · esc cancel',
        listed: '↑↓ move · enter switch · esc cancel · type to filter',
      },
    )
  }
}
