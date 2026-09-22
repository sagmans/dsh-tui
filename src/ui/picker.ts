import { matchesKey } from '@earendil-works/pi-tui'
import { hintKeys, matchesAction, moveHint, type Keymap } from '../input/actions.ts'
import { pastedText } from '../input.ts'
import { matchScore } from '../input/match.ts'
import type { StoredSession } from '../agent/history.ts'
import { describeModelRoute, modelRouteKey, type ModelChoice, type ModelRoute } from '../agent/model.ts'
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
  /** Why the last pick was refused, for as long as it stays the last thing asked. */
  readonly note: string | undefined
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

/**
 * The hint lines a list uses when it is empty and when it holds rows.
 *
 * Read at paint time rather than built once, because a settings edit while the
 * list is open moves the keys the hint names.
 */
export interface PickerHints {
  readonly empty: () => string
  readonly listed: () => string
}

/** Runs of whitespace, including the newlines a seeded draft or a paste can carry. */
const WHITESPACE = /\s+/gu

/**
 * Fold a value onto one drawn row.
 *
 * A filter can be seeded from a multiline draft or typed through a paste, and a
 * raw newline inside a row would push the frame's own accounting apart; the
 * needle the list matches with stays untouched.
 */
export function singleLine(text: string): string {
  return text.replace(WHITESPACE, ' ').trim()
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
  private note: string | undefined

  constructor(
    private readonly source: () => readonly Row[],
    private readonly heading: () => string,
    /** The value a pick settles on. */
    private readonly idOf: (row: Row) => string,
    private readonly describe: (row: Row) => PickerRow,
    /** Extra text the filter matches besides the row's own label. */
    private readonly haystackOf: (row: Row) => string,
    private readonly hints: PickerHints,
    /** The keys in force, read per press so a settings edit lands on the next key. */
    private readonly keys: () => Keymap,
    /** A draft to open already filtered by, so a search can start where the reader is. */
    initialFilter = '',
    /**
     * Told which row the cursor is on whenever it moves.
     *
     * A list whose rows can be shown as well as taken needs the row under the
     * cursor before it is picked — a theme is judged by looking at the screen it
     * paints — and only the list knows where the cursor landed once a filter has
     * reordered the rows under it.
     */
    private readonly onCursor?: (row: Row | undefined) => void,
  ) {
    this.filter = initialFilter
  }

  /** Rows matching the typed filter, best match first. */
  visible(): readonly Row[] {
    const needle = this.filter.trim()
    if (needle === '') return this.source()
    // Ties keep the order the caller listed them in, so rows do not shuffle
    // under the cursor while the reader is still typing.
    return this.source()
      .map(row => ({ row, score: matchScore(needle, this.haystackOf(row)) }))
      .filter((entry): entry is { readonly row: Row; readonly score: number } => entry.score !== undefined)
      .sort((left, right) => right.score - left.score)
      .map(entry => entry.row)
  }

  /**
   * Say why the row under the cursor cannot be taken.
   *
   * Cleared by the next key press, because it explains one refusal rather than
   * describing the list: a note that outlived it would read as a property of
   * whatever the reader moved to.
   */
  setNote(text: string | undefined): void {
    this.note = text
  }

  /** Apply one key press; returns an action only when the picker settles. */
  handleKey(data: string): PickerAction | undefined {
    const action = this.step(data)
    // A press that settles the list needs no announcement: the row it settled on
    // is the row already on screen.
    if (action === undefined) this.announce()
    return action
  }

  /**
   * Say which row the cursor is on now.
   *
   * Announced after every press rather than on the arrows alone: typing a filter
   * moves the cursor to the best match, and a row the filter just hid must not
   * stay on screen as the one being shown. A filter that matches nothing reports
   * no row, which is the one answer that is not a row.
   */
  private announce(): void {
    if (this.onCursor === undefined) return
    const rows = this.visible()
    this.onCursor(rows[Math.min(this.cursor, Math.max(0, rows.length - 1))])
  }

  /** One key press, without the announcement every way out of it owes. */
  private step(data: string): PickerAction | undefined {
    this.note = undefined
    const rows = this.visible()
    // A picker owns the keyboard while it is open, so the interrupt key has to
    // mean "leave this list" here: swallowing it would strand the reader.
    const keys = this.keys()
    if (matchesAction(keys, 'picker.cancel', data)) return { kind: 'cancel' }
    if (matchesAction(keys, 'picker.confirm', data)) {
      const chosen = rows[Math.min(this.cursor, Math.max(0, rows.length - 1))]
      return chosen === undefined ? undefined : { kind: 'pick', id: this.idOf(chosen) }
    }
    if (matchesAction(keys, 'picker.up', data)) {
      this.cursor = Math.max(0, this.cursor - 1)
      return undefined
    }
    if (matchesAction(keys, 'picker.down', data)) {
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
    const text = pastedText(data) ?? (data.length === 1 && data >= ' ' ? data : undefined)
    if (text !== undefined) {
      this.filter += text
      this.cursor = 0
    }
    return undefined
  }

  /**
   * The card as it draws right now, in the window the caller can afford.
   *
   * The window is a parameter because the caller is the one that knows how many
   * rows it has to give: a list at the end of the transcript takes the usual
   * window whatever the terminal, while a box over it has to leave room for its
   * own frame on a short screen. The rule stays here, so both windows keep the
   * cursor centred and the counts above and below honest.
   */
  card(window = PICKER_WINDOW): PickerCard {
    const rows = this.visible()
    const cursor = Math.min(this.cursor, Math.max(0, rows.length - 1))
    const size = Math.max(1, Math.min(window, rows.length))
    const start = Math.max(0, Math.min(cursor - Math.floor(size / 2), rows.length - size))
    const shown = rows.slice(start, start + size)
    return {
      title: this.heading(),
      note: this.note,
      rows: shown.map((row, index) => ({
        ...this.describe(row),
        current: start + index === cursor,
      })),
      above: start,
      below: Math.max(0, rows.length - start - shown.length),
      filter: singleLine(this.filter),
      hint: rows.length === 0 ? this.hints.empty() : this.hints.listed(),
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
    keys: () => Keymap,
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
        empty: () => `nothing matches · backspace to widen · ${hintKeys(keys(), 'picker.cancel')} cancel`,
        listed: () => `${moveHint(keys(), 'picker.up', 'picker.down')} move · ${hintKeys(keys(), 'picker.confirm')} open · ${hintKeys(keys(), 'picker.cancel')} cancel · type to filter`,
      },
      keys,
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
    keys: () => Keymap,
  ) {
    super(
      presets,
      () => `agent preset · ${presets().length} available`,
      preset => preset.id,
      preset => describePreset(preset, currentId()),
      preset => [preset.id, preset.name ?? '', preset.description ?? ''].join(' '),
      {
        empty: () => `nothing matches · backspace to widen · ${hintKeys(keys(), 'picker.cancel')} cancel`,
        listed: () => `${moveHint(keys(), 'picker.up', 'picker.down')} move · ${hintKeys(keys(), 'picker.confirm')} switch · ${hintKeys(keys(), 'picker.cancel')} cancel · type to filter`,
      },
      keys,
    )
  }
}

/**
 * One configured model route chosen by key press.
 *
 * Rows are the caller's and are re-read on every key and paint, so a provider
 * whose model list arrives after the picker opened appears in it without
 * reopening, and the filter the reader already typed applies to those late
 * rows too.
 */
export class ModelPicker extends ListPicker<ModelRoute> {
  constructor(routes: () => readonly ModelRoute[], current: () => ModelChoice | undefined, keys: () => Keymap) {
    super(
      routes,
      () => {
        const chosen = current()
        if (chosen === undefined) return 'model · no route in use'
        const effort = chosen.reasoningEffort === undefined ? '' : ` (${chosen.reasoningEffort})`
        return `model · current ${chosen.provider}/${chosen.model}${effort}`
      },
      route => modelRouteKey(route),
      route => describeModelRoute(route, current()),
      route => [route.provider, route.model, route.name].join(' '),
      {
        empty: () => `nothing matched · /model <provider>/<model> takes any id · backspace to widen · ${hintKeys(keys(), 'picker.cancel')} cancel`,
        listed: () => `${moveHint(keys(), 'picker.up', 'picker.down')} move · ${hintKeys(keys(), 'picker.confirm')} switch · ${hintKeys(keys(), 'picker.cancel')} cancel · type to filter`,
      },
      keys,
    )
  }
}

/**
 * The pick id that clears an explicit effort.
 *
 * An absent effort is a real choice — it restores the model's own default — so
 * it needs an id, and no adapter-owned effort may be empty.
 */
export const PROVIDER_DEFAULT_EFFORT_ID = ''

/** One reasoning level a route offers, as the picker shows it. */
export interface EffortChoice {
  readonly id: string
  readonly name: string
  readonly description?: string
  /** Whether this is the effort in force, which the row says in words. */
  readonly current: boolean
}

/**
 * Turn a route's advertised levels into picker rows.
 *
 * The provider default always leads, because clearing an explicit effort is a
 * choice in its own right: the reader who raised it must be able to put it back
 * without knowing what the adapter would otherwise send.
 */
export function effortChoices(
  efforts: readonly { readonly id: string; readonly name: string; readonly description?: string }[],
  effective: string | undefined,
): readonly EffortChoice[] {
  return [
    {
      id: PROVIDER_DEFAULT_EFFORT_ID,
      name: 'provider default',
      description: 'clear the explicit effort',
      current: effective === undefined,
    },
    ...efforts.map(effort => ({
      id: effort.id,
      name: effort.name,
      ...(effort.description === undefined ? {} : { description: effort.description }),
      current: effort.id === effective,
    })),
  ]
}

/**
 * One reasoning effort chosen by key press.
 *
 * The levels are fixed once the reader asks for the list, because they come
 * from the route that was in force when the picker opened; the route itself
 * cannot change while the list owns the keyboard.
 */
export class EffortPicker extends ListPicker<EffortChoice> {
  constructor(choices: () => readonly EffortChoice[], heading: string, keys: () => Keymap) {
    super(
      choices,
      () => heading,
      choice => choice.id,
      choice => ({
        label: choice.name,
        description: [
          choice.description,
          choice.id !== choice.name ? choice.id : undefined,
          choice.current ? 'current' : undefined,
        ].filter(part => part !== undefined && part !== '').join(' · ') || undefined,
        current: choice.current,
      }),
      choice => [choice.name, choice.id, choice.description ?? ''].join(' '),
      {
        empty: () => `nothing matches · backspace to widen · ${hintKeys(keys(), 'picker.cancel')} cancel`,
        listed: () => `${moveHint(keys(), 'picker.up', 'picker.down')} move · ${hintKeys(keys(), 'picker.confirm')} apply · ${hintKeys(keys(), 'picker.cancel')} cancel · type to filter`,
      },
      keys,
    )
  }
}
