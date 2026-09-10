import type { Context } from '@deepseek-ai/cordis'
import { describeDuration } from './jobs.ts'

/** One delegation this session started, as the surface shows it. */
export interface SubagentRun {
  readonly runId: string
  readonly provider: string
  readonly id: string
  readonly startedAt: number
  readonly status: 'running' | 'completed' | 'failed'
  readonly stopReason?: string
  readonly finishedAt?: number
}

/** Child rows the dock lists before the count takes over. */
export const DOCK_SUBAGENT_LIMIT = 2

/** Id characters kept in a row, so an id cannot smuggle in a control sequence. */
const SHORT_ID_LENGTH = 8

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
 * events, so this is live state: the durable record of a delegation is the tool
 * call that asked for it, and a resumed run starts with an empty roster.
 */
export class SubagentRoster {
  private readonly runs = new Map<string, SubagentRun>()

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Record a started run; an unknown shape is ignored rather than guessed at. */
  start(info: unknown): void {
    const record = asRecord(info)
    const runId = record?.runId
    const id = record?.id
    if (typeof runId !== 'string' || typeof id !== 'string') return
    this.runs.set(runId, {
      runId,
      id,
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
  }
}

/** One delegation as a row. */
export function describeSubagent(run: SubagentRun, now: number): string {
  const age = run.status === 'running'
    ? `running ${describeDuration(now - run.startedAt)}`
    : `${run.status}${run.stopReason === undefined || run.stopReason === 'completed' ? '' : ` (${run.stopReason})`} ${describeDuration((run.finishedAt ?? run.startedAt) - run.startedAt)}`
  return `${shortId(run.id)} · ${run.provider} · ${age}`
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
  | { readonly kind: 'kill'; readonly id: string }
  | { readonly kind: 'invalid'; readonly reason: string }

/** Read a `/subagents` argument; the id is the only handle, so actions stay explicit. */
export function parseSubagentsArgument(argument: string): SubagentsCommand {
  const parts = argument.trim().split(/\s+/u).filter(part => part !== '')
  if (parts.length === 0) return { kind: 'list' }
  const [verb = '', id = ''] = parts
  if (verb !== 'kill') return { kind: 'invalid', reason: `unknown action "${verb}" — use /subagents or /subagents kill <id>` }
  if (id === '') return { kind: 'invalid', reason: 'kill needs a child id; /subagents lists them' }
  return { kind: 'kill', id }
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
