import type { Context } from '@deepseek-ai/cordis'
import { describeDuration } from './jobs.ts'
import { stripControlCharacters } from './text.ts'

/** One delegation this session started, as the surface shows it. */
export interface SubagentRun {
  readonly runId: string
  readonly provider: string
  readonly id: string
  readonly label?: string
  readonly startedAt: number
  readonly status: 'running' | 'completed' | 'failed'
  readonly stopReason?: string
  readonly finishedAt?: number
}

/** Child rows the dock lists before the count takes over. */
export const DOCK_SUBAGENT_LIMIT = 3

/** Id characters kept in a row, so an id cannot smuggle in a control sequence. */
const SHORT_ID_LENGTH = 8

/** Maximum task words the dock can show without hiding child status. */
const MAX_TASK_WORDS = 10

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/** Short form of a child session id: enough to tell two children apart. */
export function shortId(id: string): string {
  return id.length <= SHORT_ID_LENGTH ? id : id.slice(0, SHORT_ID_LENGTH)
}

/**
 * Track the delegations of one session.
 *
 * Subagent lifecycle arrives as service events rather than durable session
 * events, while the parent's catalog supplies the task. This roster remains
 * live state, so a resumed run starts empty even when its catalog is durable.
 */
export class SubagentRoster {
  private readonly runs = new Map<string, SubagentRun>()
  private readonly labels = new Map<string, string>()

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Catalog entries precede starts normally; keep them for either event order. */
  catalog(info: unknown): void {
    const record = asRecord(info)
    const id = record?.childId
    const raw = record?.label
    if (typeof id !== 'string' || typeof raw !== 'string') return
    const label = stripControlCharacters(raw).trim().replace(/\s+/gu, ' ').split(' ').slice(0, MAX_TASK_WORDS).join(' ')
    if (label === '') return
    this.labels.set(id, label)
    for (const [runId, run] of this.runs) {
      if (run.id === id) this.runs.set(runId, { ...run, label })
    }
  }

  /** Record a started run; an unknown shape is ignored rather than guessed at. */
  start(info: unknown): void {
    const record = asRecord(info)
    const runId = record?.runId
    const id = record?.id
    if (typeof runId !== 'string' || typeof id !== 'string') return
    const label = this.labels.get(id)
    this.runs.set(runId, {
      runId,
      id,
      ...(label === undefined ? {} : { label }),
      provider: typeof record?.provider === 'string' ? record.provider : 'subagent',
      startedAt: this.now(),
      status: 'running',
    })
  }

  /** Settle a run; an end without its start still becomes a row. */
  end(info: unknown): void {
    const record = asRecord(info)
    const runId = record?.runId
    if (typeof runId !== 'string') return
    const existing = this.runs.get(runId)
    const stopReason = typeof record?.stopReason === 'string' ? record.stopReason : undefined
    this.runs.set(runId, {
      runId,
      id: typeof record?.id === 'string' ? record.id : existing?.id ?? runId,
      ...(existing?.label === undefined ? {} : { label: existing.label }),
      provider: typeof record?.provider === 'string' ? record.provider : existing?.provider ?? 'subagent',
      startedAt: existing?.startedAt ?? this.now(),
      status: stopReason === undefined || stopReason === 'completed' ? 'completed' : 'failed',
      ...(stopReason === undefined ? {} : { stopReason }),
      finishedAt: this.now(),
    })
  }

  list(): readonly SubagentRun[] {
    return [...this.runs.values()].sort((left, right) => right.startedAt - left.startedAt)
  }

  running(): readonly SubagentRun[] {
    return this.list().filter(run => run.status === 'running')
  }

  reset(): void {
    this.runs.clear()
    this.labels.clear()
  }
}

/** One delegation as a row. */
export function describeSubagent(run: SubagentRun, now: number): string {
  const age = run.status === 'running'
    ? `running ${describeDuration(now - run.startedAt)}`
    : `${run.status}${run.stopReason === undefined || run.stopReason === 'completed' ? '' : ` (${run.stopReason})`} ${describeDuration((run.finishedAt ?? run.startedAt) - run.startedAt)}`
  return `${shortId(run.id)}${run.label === undefined ? '' : ` · ${run.label}`} · ${run.provider} · ${age}`
}

/** The whole roster as lines. */
export function describeSubagents(runs: readonly SubagentRun[], now: number): string {
  if (runs.length === 0) return 'no subagents have run in this session'
  const running = runs.filter(run => run.status === 'running').length
  const header = `subagents · ${runs.length}${running === 0 ? '' : ` (${running} running)`}`
  return [header, ...runs.map(run => `  ${describeSubagent(run, now)}`)].join('\n')
}

/** What a `/subagents` argument asks the surface to do. */
export type SubagentsCommand =
  | { readonly kind: 'list' }
  | { readonly kind: 'open'; readonly id: string }
  | { readonly kind: 'kill'; readonly id: string }
  | { readonly kind: 'invalid'; readonly reason: string }

/** Actions a reader can name, so an unknown verb is refused instead of guessed at. */
const ACTIONS = new Set(['open', 'kill'])

/** Read a `/subagents` argument; the id is the only handle, so actions stay explicit. */
export function parseSubagentsArgument(argument: string): SubagentsCommand {
  const parts = argument.trim().split(/\s+/u).filter(part => part !== '')
  if (parts.length === 0) return { kind: 'list' }
  const [verb = '', id = ''] = parts
  if (!ACTIONS.has(verb)) {
    return { kind: 'invalid', reason: `unknown action "${verb}" — use /subagents, /subagents open <id>, or /subagents kill <id>` }
  }
  if (id === '') return { kind: 'invalid', reason: `${verb} needs a child id; /subagents lists them` }
  return verb === 'open' ? { kind: 'open', id } : { kind: 'kill', id }
}

/** Names the most recent run, for a reader who just watched one start. */
export const LAST_RUN = 'last'

/**
 * Find one run by exact id or unambiguous prefix.
 *
 * Rows show a short id, so the reader types what they can see; an ambiguous
 * prefix resolves to nothing rather than to the wrong child. \`last\` names the
 * newest run, because copying a uuid out of a terminal is not a workflow.
 */
export function resolveRun(runs: readonly SubagentRun[], idOrPrefix: string): SubagentRun | undefined {
  // The roster happens to hand these over newest first; picking by time keeps
  // the shortcut honest even if a caller ever hands them over differently.
  if (idOrPrefix === LAST_RUN) {
    return runs.reduce<SubagentRun | undefined>(
      (newest, run) => newest === undefined || run.startedAt > newest.startedAt ? run : newest,
      undefined,
    )
  }
  const exact = runs.find(run => run.id === idOrPrefix)
  if (exact !== undefined) return exact
  const matches = runs.filter(run => run.id.startsWith(idOrPrefix))
  return matches.length === 1 ? matches[0] : undefined
}

/** The part of the agent registry a stop needs, described structurally. */
interface AgentRegistryLike {
  get?(id: string): { cancel?(cause: { kind: 'user' }): unknown } | undefined
}

/**
 * Stop one live child.
 *
 * A delegation is an ordinary agent in the same process, so a stop is the same
 * cancel a reader's Ctrl+C sends to the parent; a child that already settled is
 * reported rather than pretended away.
 */
export function createSubagentControl(ctx: Context): { stop(id: string): boolean } | undefined {
  const agents = ctx.get('agents') as AgentRegistryLike | undefined
  if (typeof agents?.get !== 'function') return undefined
  return {
    stop: id => {
      const child = agents.get?.(id)
      if (child?.cancel === undefined) return false
      child.cancel({ kind: 'user' })
      return true
    },
  }
}
