import type {
  SessionId,
  SubagentAddress,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SubagentCatalogSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ConversationSubagentCatalogView,
  ConversationSubagentComposerView,
  ConversationSubagentListState,
  ConversationSubagentRowView,
  ConversationSubagentsSource,
} from './contracts.js'
import { sanitizeText } from '../sessions/projection.js'

const TOKEN_THOUSAND = 1_000
const TOKEN_MILLION = 1_000_000
const TOKEN_ROUNDING_THRESHOLD = 100
const MILLISECONDS_PER_SECOND = 1_000
const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60
const HOURS_PER_DAY = 24
const DAYS_PER_MONTH = 30
const DAYS_PER_YEAR = 365
const ONE_SHOT_MODE = 'one-shot'
const CONTINUABLE_MODE = 'continuable'
const RUNNING_ACTIVITY = 'running'
const INACTIVE_ACTIVITY = 'inactive'
const LOADING_LABEL = 'Loading…'
const LOAD_ERROR_LABEL = 'Catalog unavailable'
const TOKEN_SUFFIX = 'tok'
const DIAGNOSTIC_LABELS = Object.freeze({
  corrupt: 'Corrupt catalog entry',
  unavailable: 'Catalog entry unavailable',
  unsupported: 'Unsupported catalog entry',
})

interface CatalogProjectionOptions {
  readonly activeRowKey: string | undefined
  readonly expanded: ReadonlySet<SessionId>
  readonly now: number
  readonly open: boolean
}

interface UsageView {
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly outputTokens: number
  readonly uncachedInputTokens: number
}

interface TimingView {
  readonly active: {
    readonly since: number
    readonly through: number
  } | undefined
  readonly settledMs: number
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function usageOf(value: unknown): UsageView | undefined {
  if (!record(value)) return undefined
  const cacheReadTokens = finiteNumber(value.cacheReadTokens)
  const cacheWriteTokens = finiteNumber(value.cacheWriteTokens)
  const outputTokens = finiteNumber(value.outputTokens)
  const uncachedInputTokens = finiteNumber(value.uncachedInputTokens)
  if (cacheReadTokens === undefined
    || cacheWriteTokens === undefined
    || outputTokens === undefined
    || uncachedInputTokens === undefined) return undefined
  return { cacheReadTokens, cacheWriteTokens, outputTokens, uncachedInputTokens }
}

function timingOf(value: unknown): TimingView | undefined {
  if (!record(value)) return undefined
  const settledMs = finiteNumber(value.settledMs)
  if (settledMs === undefined) return undefined
  if (value.active === undefined) return { active: undefined, settledMs }
  if (!record(value.active)) return undefined
  const since = finiteNumber(value.active.since)
  const through = finiteNumber(value.active.through)
  return since === undefined || through === undefined
    ? undefined
    : { active: { since, through }, settledMs }
}

function tokenTotal(summary: ConversationSubagentListState['byId'][SessionId]): number | undefined {
  const values = summary?.projectionValues
  const usage = usageOf(values?.tokenUsage)
  return usage === undefined
    ? undefined
    : usage.uncachedInputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

function activityDuration(
  summary: ConversationSubagentListState['byId'][SessionId],
  activity: typeof RUNNING_ACTIVITY | typeof INACTIVE_ACTIVITY,
  now: number,
): number | undefined {
  const timing = timingOf(summary?.projectionValues?.subagentTiming)
  if (timing === undefined) return undefined
  if (timing.active === undefined) return timing.settledMs
  const end = activity === RUNNING_ACTIVITY ? now : timing.active.through
  return timing.settledMs + Math.max(0, end - timing.active.since)
}

function scaled(value: number): string {
  return value >= TOKEN_ROUNDING_THRESHOLD
    ? String(Math.round(value))
    : String(Math.round(value * 10) / 10)
}

function formatTokens(value: number): string {
  if (value < TOKEN_THOUSAND) return String(value)
  if (value < TOKEN_MILLION) return `${scaled(value / TOKEN_THOUSAND)}K`
  return `${scaled(value / TOKEN_MILLION)}M`
}

interface DurationParts {
  readonly days: number
  readonly hours: number
  readonly minutes: number
  readonly seconds: number
  readonly totalHours: number
  readonly totalMinutes: number
}

function splitDuration(milliseconds: number): DurationParts {
  const totalSeconds = Math.floor(Math.max(0, milliseconds) / MILLISECONDS_PER_SECOND)
  const totalMinutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE)
  const totalHours = Math.floor(totalMinutes / MINUTES_PER_HOUR)
  return {
    days: Math.floor(totalHours / HOURS_PER_DAY),
    hours: totalHours % HOURS_PER_DAY,
    minutes: totalMinutes % MINUTES_PER_HOUR,
    seconds: totalSeconds % SECONDS_PER_MINUTE,
    totalHours,
    totalMinutes,
  }
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function formatDuration(milliseconds: number): string {
  const parts = splitDuration(milliseconds)
  if (parts.days >= DAYS_PER_YEAR) {
    const years = Math.floor(parts.days / DAYS_PER_YEAR)
    const months = Math.floor((parts.days % DAYS_PER_YEAR) / DAYS_PER_MONTH)
    return months === 0 ? `${years}y` : `${years}y ${months}mo`
  }
  if (parts.days >= DAYS_PER_MONTH) {
    const months = Math.floor(parts.days / DAYS_PER_MONTH)
    const days = parts.days % DAYS_PER_MONTH
    return days === 0 ? `${months}mo` : `${months}mo ${days}d`
  }
  if (parts.days > 0) return parts.hours === 0 ? `${parts.days}d` : `${parts.days}d ${parts.hours}h`
  if (parts.totalHours > 0) return `${parts.totalHours}:${pad(parts.minutes)}:${pad(parts.seconds)}`
  if (parts.totalMinutes > 0) return `${parts.totalMinutes}:${pad(parts.seconds)}`
  return `${parts.seconds}s`
}

function formatExactDuration(milliseconds: number): string {
  const parts = splitDuration(milliseconds)
  return parts.days === 0
    ? formatDuration(milliseconds)
    : `${parts.days}d ${pad(parts.hours)}:${pad(parts.minutes)}:${pad(parts.seconds)}`
}

function descendantCounts(
  state: ConversationSubagentListState,
  rootSessionId: SessionId,
): { readonly count: number; readonly runningCount: number } {
  let count = 0
  let runningCount = 0
  for (const descendant of Object.values(state.byId)) {
    if (descendant?.origin !== 'subagent') continue
    const seen = new Set<SessionId>()
    let current: typeof descendant | undefined = descendant
    while (current?.origin === 'subagent' && current.parentId !== undefined) {
      const currentId = current.id
      if (seen.has(currentId)) break
      seen.add(currentId)
      if (current.parentId === rootSessionId) {
        count++
        if (descendant.running) runningCount++
        break
      }
      current = state.byId[current.parentId]
    }
  }
  return { count, runningCount }
}

function directSummaryChildren(
  state: ConversationSubagentListState,
  parentSessionId: SessionId,
): readonly NonNullable<ConversationSubagentListState['byId'][SessionId]>[] {
  return Object.values(state.byId).filter((summary): summary is NonNullable<typeof summary> => (
    summary !== undefined && summary.origin === 'subagent' && summary.parentId === parentSessionId
  ))
}

function rowKey(parentSessionId: SessionId, childSessionId: SessionId): string {
  return `${String(parentSessionId)}:${String(childSessionId)}`
}

function diagnosticReason(reason: 'corrupt' | 'unavailable' | 'unsupported'): string {
  switch (reason) {
    case 'corrupt': return DIAGNOSTIC_LABELS.corrupt
    case 'unavailable': return DIAGNOSTIC_LABELS.unavailable
    case 'unsupported': return DIAGNOSTIC_LABELS.unsupported
    default: {
      const exhaustive: never = reason
      return exhaustive
    }
  }
}

function loadingRows(
  state: ConversationSubagentListState,
  parentSessionId: SessionId,
  depth: number,
  activeRowKey: string | undefined,
): ConversationSubagentRowView[] {
  const known = directSummaryChildren(state, parentSessionId)
  if (known.length === 0) {
    const key = `${String(parentSessionId)}:loading`
    return [{
      active: key === activeRowKey,
      depth,
      enabled: false,
      key,
      kind: 'loading',
      label: LOADING_LABEL,
      parentSessionId,
      summary: LOADING_LABEL,
    }]
  }
  return known.map((summary) => {
    const key = `${rowKey(parentSessionId, summary.id)}:loading`
    return {
      active: key === activeRowKey,
      depth,
      enabled: false,
      key,
      kind: 'loading' as const,
      label: LOADING_LABEL,
      parentSessionId,
      sessionId: summary.id,
      summary: LOADING_LABEL,
    }
  })
}

function catalogRows(
  state: ConversationSubagentListState,
  parentSessionId: SessionId,
  catalog: SubagentCatalogSnapshot | undefined,
  options: CatalogProjectionOptions,
  depth: number,
  visited: ReadonlySet<SessionId>,
): ConversationSubagentRowView[] {
  if (visited.has(parentSessionId)) return []
  const nextVisited = new Set(visited).add(parentSessionId)
  if (catalog === undefined || (catalog.state === 'loading' && catalog.entries.length === 0)) {
    return loadingRows(state, parentSessionId, depth, options.activeRowKey)
  }
  const rows: ConversationSubagentRowView[] = []
  if (catalog.state === 'error') {
    const key = `${String(parentSessionId)}:error`
    rows.push({
      active: key === options.activeRowKey,
      depth,
      enabled: true,
      key,
      kind: 'error',
      label: LOAD_ERROR_LABEL,
      parentSessionId,
      summary: sanitizeText(catalog.error?.message ?? LOAD_ERROR_LABEL),
    })
  }
  for (const entry of catalog.entries) {
    if (entry.kind === 'diagnostic') {
      const key = rowKey(parentSessionId, entry.id)
      const reason = diagnosticReason(entry.reason)
      rows.push({
        active: key === options.activeRowKey,
        depth,
        enabled: false,
        key,
        kind: 'diagnostic',
        label: String(entry.id),
        parentSessionId,
        reason: entry.reason,
        sessionId: entry.id,
        summary: reason,
      })
      continue
    }
    const key = rowKey(parentSessionId, entry.id)
    const summary = state.byId[entry.id]
    const label = sanitizeText(entry.label ?? String(entry.id))
    const title = summary?.title === undefined ? undefined : sanitizeText(summary.title)
    const total = tokenTotal(summary)
    const durationMs = activityDuration(summary, entry.activity, options.now)
    const tokenMetric = total === undefined ? undefined : `${formatTokens(total)} ${TOKEN_SUFFIX}`
    const duration = durationMs === undefined ? undefined : formatDuration(durationMs)
    const exactDuration = durationMs === undefined ? undefined : formatExactDuration(durationMs)
    const secondary = [title, entry.mode, entry.activity, tokenMetric, duration]
      .filter((value): value is string => value !== undefined)
      .join(' · ')
    const expanded = entry.hasChildren && options.expanded.has(entry.id)
    rows.push({
      active: key === options.activeRowKey,
      activity: entry.activity,
      depth,
      duration,
      enabled: true,
      exactDuration,
      expanded,
      hasChildren: entry.hasChildren,
      key,
      kind: 'child',
      label,
      mode: entry.mode,
      parentSessionId,
      sessionId: entry.id,
      summary: secondary,
      tokenMetric,
    })
    if (expanded) {
      rows.push(...catalogRows(
        state,
        entry.id,
        state.subagentsByParent[entry.id],
        options,
        depth + 1,
        nextVisited,
      ))
    }
  }
  return rows
}

export function projectSubagentCatalog(
  state: ConversationSubagentListState,
  rootSessionId: SessionId,
  options: CatalogProjectionOptions,
): ConversationSubagentCatalogView | undefined {
  const catalog = state.subagentsByParent[rootSessionId]
  const directCount = catalog?.entries.filter(entry => entry.kind === 'child').length ?? 0
  const descendants = descendantCounts(state, rootSessionId)
  const count = Math.max(directCount, descendants.count)
  const visible = catalog !== undefined
    && (catalog.state === 'error' || catalog.entries.length > 0 || count > 0)
    || count > 0
  if (!visible) return undefined
  const rows = options.open
    ? catalogRows(state, rootSessionId, catalog, options, 0, new Set())
    : []
  return Object.freeze({
    activeRowKey: options.activeRowKey,
    count,
    open: options.open,
    rows: Object.freeze(rows),
    runningCount: descendants.runningCount,
  })
}

export function projectSubagentComposer(
  subagent: { readonly address: SubagentAddress; readonly parentAvailable: boolean } | null | undefined,
  running: boolean,
): ConversationSubagentComposerView | undefined {
  if (subagent === null || subagent === undefined) return undefined
  const mode = subagent.address.mode
  if (mode === ONE_SHOT_MODE) {
    return Object.freeze({
      attachmentEnabled: false,
      inputEnabled: false,
      mode,
      parentAvailable: subagent.parentAvailable,
      readOnlyReason: ONE_SHOT_MODE,
      sendEnabled: false,
      stopEnabled: false,
    })
  }
  if (mode !== CONTINUABLE_MODE) {
    const exhaustive: never = mode
    return exhaustive
  }
  if (!subagent.parentAvailable) {
    return Object.freeze({
      attachmentEnabled: false,
      inputEnabled: false,
      mode,
      parentAvailable: false,
      readOnlyReason: running ? undefined : 'parent-unavailable',
      sendEnabled: false,
      stopEnabled: running,
    })
  }
  return Object.freeze({
    attachmentEnabled: false,
    inputEnabled: true,
    mode,
    parentAvailable: true,
    readOnlyReason: undefined,
    sendEnabled: true,
    stopEnabled: running,
  })
}

export class ConversationSubagentNavigator {
  private readonly expanded = new Set<SessionId>()
  private readonly observed = new Set<SessionId>()
  private activeRowKey: string | undefined
  private open = false
  private rootSessionId: SessionId | undefined

  constructor(private readonly source: ConversationSubagentsSource) {
    this.rootSessionId = source.list.getSnapshot().current
  }

  activate(now: number): boolean {
    const row = this.rows(now).find(candidate => candidate.key === this.activeRowKey)
    if (row?.kind !== 'child' || row.sessionId === undefined || row.mode === undefined) return false
    const address: SubagentAddress = {
      parentSessionId: row.parentSessionId,
      childSessionId: row.sessionId,
      mode: row.mode,
    }
    this.close()
    this.source.open(address)
    return true
  }

  close(): void {
    if (!this.open && this.observed.size === 0) return
    this.open = false
    for (const parentSessionId of this.observed) this.source.setOpen(parentSessionId, false)
    this.observed.clear()
    this.expanded.clear()
    this.activeRowKey = undefined
  }

  dispose(): void {
    this.close()
  }

  move(delta: number, now: number): void {
    if (!Number.isFinite(delta) || delta === 0) return
    const rows = this.rows(now).filter(row => row.enabled && row.kind !== 'error')
    if (rows.length === 0) return
    const current = rows.findIndex(row => row.key === this.activeRowKey)
    const next = current < 0
      ? delta < 0 ? rows.length - 1 : 0
      : (current + (delta < 0 ? -1 : 1) + rows.length) % rows.length
    this.activeRowKey = rows[next]?.key
  }

  refresh(parentSessionId?: SessionId): Promise<void> {
    const target = parentSessionId ?? this.rootSessionId
    return target === undefined ? Promise.resolve() : this.source.refresh(target)
  }

  select(key: string, now: number): void {
    const row = this.rows(now).find(candidate => candidate.key === key)
    if (row?.enabled === true) this.activeRowKey = key
  }

  snapshot(now: number): ConversationSubagentCatalogView | undefined {
    const root = this.rootSessionId
    if (root === undefined) return undefined
    let projected = projectSubagentCatalog(this.source.list.getSnapshot(), root, {
      activeRowKey: this.activeRowKey,
      expanded: this.expanded,
      now,
      open: this.open,
    })
    if (projected === undefined) {
      this.close()
      return undefined
    }
    const selected = projected.rows.find(row => row.key === this.activeRowKey && row.enabled)
    if (this.open && selected === undefined) {
      this.activeRowKey = projected.rows.find(row => row.enabled && row.kind === 'child')?.key
      projected = projectSubagentCatalog(this.source.list.getSnapshot(), root, {
        activeRowKey: this.activeRowKey,
        expanded: this.expanded,
        now,
        open: this.open,
      }) ?? projected
    }
    return projected
  }

  syncRoot(rootSessionId: SessionId | undefined): void {
    if (rootSessionId === this.rootSessionId) return
    this.close()
    this.rootSessionId = rootSessionId
  }

  toggle(now: number): void {
    if (this.open) {
      this.close()
      return
    }
    const root = this.rootSessionId
    if (root === undefined) return
    const projected = projectSubagentCatalog(this.source.list.getSnapshot(), root, {
      activeRowKey: undefined,
      expanded: this.expanded,
      now,
      open: true,
    })
    if (projected === undefined) return
    this.open = true
    this.observe(root, true)
    this.activeRowKey = projected.rows.find(row => row.enabled && row.kind === 'child')?.key
  }

  toggleBranch(key: string, now: number): void {
    const row = this.rows(now).find(candidate => candidate.key === key)
    if (row?.kind !== 'child' || row.sessionId === undefined || row.hasChildren !== true) return
    if (this.expanded.has(row.sessionId)) {
      this.closeBranch(row.sessionId)
      return
    }
    this.expanded.add(row.sessionId)
    this.observe(row.sessionId, true)
    this.activeRowKey = row.key
  }

  private closeBranch(root: SessionId): void {
    const closing = new Set<SessionId>()
    const visit = (parentSessionId: SessionId): void => {
      if (closing.has(parentSessionId) || !this.expanded.has(parentSessionId)) return
      closing.add(parentSessionId)
      const catalog = this.source.list.getSnapshot().subagentsByParent[parentSessionId]
      for (const entry of catalog?.entries ?? []) {
        if (entry.kind === 'child') visit(entry.id)
      }
    }
    visit(root)
    for (const parentSessionId of closing) this.observe(parentSessionId, false)
    for (const parentSessionId of closing) this.expanded.delete(parentSessionId)
  }

  private observe(parentSessionId: SessionId, open: boolean): void {
    if (open) this.observed.add(parentSessionId)
    else this.observed.delete(parentSessionId)
    this.source.setOpen(parentSessionId, open)
  }

  private rows(now: number): readonly ConversationSubagentRowView[] {
    return this.snapshot(now)?.rows ?? []
  }
}
