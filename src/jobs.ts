import type { Context } from '@deepseek-ai/cordis'
import { describeAge } from './ui/picker.ts'

/** Lifecycle states a background job can be in. */
export type JobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed'

/** One background job as the surface shows it. */
export interface JobSummary {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly status: JobStatus
  readonly startedAt: number
  readonly finishedAt: number | undefined
}

/** What a `/jobs` argument asks the surface to do. */
export type JobsCommand =
  | { readonly kind: 'list' }
  | { readonly kind: 'read'; readonly id: string }
  | { readonly kind: 'kill'; readonly id: string }

/** Jobs the dock lists before the count takes over. */
export const DOCK_JOB_LIMIT = 2

/** Output lines a `/jobs read` shows, so a chatty job cannot flood the view. */
export const JOB_READ_LINES = 20

const SECOND_MS = 1000
const MINUTE_MS = 60 * SECOND_MS
const HOUR_MS = 60 * MINUTE_MS
const STATUSES = new Set<JobStatus>(['running', 'stopping', 'completed', 'killed', 'failed'])

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/** How long a job ran, or has been running, in the reader's units. */
export function describeDuration(ms: number): string {
  const elapsed = Math.max(0, ms)
  if (elapsed < MINUTE_MS) return `${Math.max(1, Math.round(elapsed / SECOND_MS))}s`
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m${String(Math.round((elapsed % MINUTE_MS) / SECOND_MS)).padStart(2, '0')}s`
  return `${Math.floor(elapsed / HOUR_MS)}h${String(Math.floor((elapsed % HOUR_MS) / MINUTE_MS)).padStart(2, '0')}m`
}

/** Whether a job still holds resources. */
export function isLive(status: JobStatus): boolean {
  return status === 'running' || status === 'stopping'
}

/** When a settled job ended, in the reader's units. */
function describeFinished(job: JobSummary, now: number): string {
  const finishedAt = job.finishedAt ?? job.startedAt
  const elapsed = Math.max(0, now - finishedAt)
  if (elapsed < SECOND_MS) return 'just now'
  return elapsed < MINUTE_MS ? `${describeDuration(elapsed)} ago` : describeAge(finishedAt, now)
}

/** One job as a single row, with its duration and where it ended up. */
export function describeJob(job: JobSummary, now: number): string {
  const time = isLive(job.status)
    ? `${job.status} ${describeDuration(now - job.startedAt)}`
    : `${job.status} ${describeFinished(job, now)}`
  const label = job.label.trim() === '' ? job.kind : job.label
  return `${job.id} · ${time} — ${label}`
}

/** The whole board as lines, newest first, so a reader can see what is running. */
export function describeJobs(jobs: readonly JobSummary[], now: number): string {
  if (jobs.length === 0) return 'no background jobs'
  const live = jobs.filter(job => isLive(job.status)).length
  const header = `jobs · ${jobs.length}${live === 0 ? '' : ` (${live} running)`}`
  const rows = [...jobs]
    .sort((left, right) => right.startedAt - left.startedAt)
    .slice(0, JOB_READ_LINES)
    .map(job => `  ${describeJob(job, now)}`)
  return [header, ...rows].join('\n')
}

/**
 * Read a `/jobs` argument.
 *
 * The forms stay explicit because the id is the only handle a reader has on a
 * job: a bare id would be ambiguous between reading and killing it.
 */
export function parseJobsArgument(argument: string): JobsCommand | { readonly kind: 'invalid'; readonly reason: string } {
  const parts = argument.trim().split(/\s+/u).filter(part => part !== '')
  if (parts.length === 0) return { kind: 'list' }
  const [verb = '', id = ''] = parts
  if (verb !== 'read' && verb !== 'kill') {
    return { kind: 'invalid', reason: `unknown action "${verb}" — use /jobs, /jobs read <id>, or /jobs kill <id>` }
  }
  if (id === '') return { kind: 'invalid', reason: `${verb} needs a job id; /jobs lists them` }
  return verb === 'read' ? { kind: 'read', id } : { kind: 'kill', id }
}

/** The part of the job registry this surface uses, described structurally. */
interface JobRegistryLike {
  list?(caller?: unknown): readonly unknown[]
  read?(id: string, caller?: unknown): unknown
  kill?(id: string, caller?: unknown, reason?: string): unknown
  onJobsChanged?(listener: (owner?: unknown) => void): () => void
}

function toSummary(value: unknown): JobSummary | undefined {
  const record = asRecord(value)
  const id = record?.id
  const status = record?.status
  if (typeof id !== 'string' || typeof status !== 'string' || !STATUSES.has(status as JobStatus)) return undefined
  return {
    id,
    kind: typeof record?.kind === 'string' ? record.kind : 'job',
    label: typeof record?.label === 'string' ? record.label : '',
    status: status as JobStatus,
    startedAt: typeof record?.startedAt === 'number' ? record.startedAt : 0,
    finishedAt: typeof record?.finishedAt === 'number' ? record.finishedAt : undefined,
  }
}

/** The background-job registry, when the composition mounts one. */
export interface JobDirectory {
  list(caller: unknown): readonly JobSummary[]
  read(caller: unknown, id: string): { readonly text: string; readonly snapshot: JobSummary | undefined } | undefined
  kill(caller: unknown, id: string): 'requested' | 'already-finished' | undefined
  /** Watch for changes; the callback receives the owner the change belongs to. */
  watch(listener: (owner: unknown) => void): () => void
}

/**
 * Wrap the job registry.
 *
 * Jobs are live process state rather than durable events, so this is the one
 * part of the surface a resume cannot reconstruct: the dock shows what this
 * run started, and says so by simply being empty afterwards.
 */
export function createJobDirectory(ctx: Context): JobDirectory | undefined {
  const registry = ctx.get('jobs') as JobRegistryLike | undefined
  if (typeof registry?.list !== 'function') return undefined
  return {
    list: caller => (registry.list?.(caller) ?? []).flatMap(entry => {
      const summary = toSummary(entry)
      return summary === undefined ? [] : [summary]
    }),
    read: (caller, id) => {
      const result = asRecord(registry.read?.(id, caller))
      if (result === undefined) return undefined
      return {
        text: typeof result.text === 'string' ? result.text : '',
        snapshot: toSummary(result.snapshot),
      }
    },
    kill: (caller, id) => {
      const outcome = registry.kill?.(id, caller, 'killed from the terminal')
      return outcome === 'requested' || outcome === 'already-finished' ? outcome : undefined
    },
    watch: listener => {
      if (typeof registry.onJobsChanged !== 'function') return () => {}
      return registry.onJobsChanged(listener)
    },
  }
}
