import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { describeAge } from './ui/picker.ts'

/** Lifecycle states a background job can be in. */
export type JobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed'

/** One background job as the surface shows it. */
export interface JobSummary {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly status: JobStatus
  readonly startedAt: number | undefined
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

const JOB_ACTION_ARGUMENT_COUNT = 2
/** UI reads start at retained history rather than advancing the model's cursor. */
const JOB_OUTPUT_START_OFFSET = 0
const JOB_EXTRA_ARGUMENT_REASON = 'accepts only a job id; use /jobs read <id> or /jobs kill <id>'

const SECOND_MS = 1000
const MINUTE_MS = 60 * SECOND_MS
const HOUR_MS = 60 * MINUTE_MS
const STATUSES = new Set<JobStatus>(['running', 'stopping', 'completed', 'killed', 'failed'])

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/** How long a job ran, or has been running, in the reader's units. */
export function describeDuration(ms: number): string {
  // Whole elapsed seconds never claim time that has not passed or produce a 60-second remainder.
  if (!Number.isFinite(ms)) return 'unknown'
  const elapsed = Math.floor(Math.max(0, ms) / SECOND_MS) * SECOND_MS
  if (elapsed < MINUTE_MS) return `${elapsed / SECOND_MS}s`
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m${String((elapsed % MINUTE_MS) / SECOND_MS).padStart(2, '0')}s`
  return `${Math.floor(elapsed / HOUR_MS)}h${String(Math.floor((elapsed % HOUR_MS) / MINUTE_MS)).padStart(2, '0')}m`
}

/** Whether a job still holds resources. */
export function isLive(status: JobStatus): boolean {
  return status === 'running' || status === 'stopping'
}

/** When a settled job ended, in the reader's units. */
function describeFinished(job: JobSummary, now: number): string {
  // A missing completion timestamp cannot establish when the job actually settled.
  const finishedAt = job.finishedAt
  if (finishedAt === undefined) return 'time unknown'
  const elapsed = Math.max(0, now - finishedAt)
  if (elapsed < SECOND_MS) return 'just now'
  return elapsed < MINUTE_MS ? `${describeDuration(elapsed)} ago` : describeAge(finishedAt, now)
}

/** One job as a single row, with its duration and where it ended up. */
export function describeJob(job: JobSummary, now: number): string {
  const time = isLive(job.status)
    ? `${job.status} ${job.startedAt === undefined ? 'duration unknown' : describeDuration(now - job.startedAt)}`
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
    .sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0))
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
  // Reject ambiguous intent before registry reads consume output or kills stop work.
  if (parts.length > JOB_ACTION_ARGUMENT_COUNT) return { kind: 'invalid', reason: `${verb} ${JOB_EXTRA_ARGUMENT_REASON}` }
  return verb === 'read' ? { kind: 'read', id } : { kind: 'kill', id }
}

/** The part of the job registry this surface uses, described structurally. */
// Listing remains useful without action or watch capabilities, so those methods are optional.
interface JobRegistryLike {
  list?(caller: SessionId): readonly unknown[]
  get?(id: string, caller: SessionId): unknown
  readAt?(id: string, from: number, caller: SessionId): unknown
  kill?(id: string, caller: SessionId, reason?: string): unknown
  readonly events?: { subscribe(filter: { readonly owners: 'all' }, listener: (event: unknown) => void): () => void }
}

// Keep identifiable jobs visible without display metadata; fallback timestamps do not establish actual job times.
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
    // Missing or invalid timestamps cannot establish a duration or completion age.
    startedAt: typeof record?.startedAt === 'number' && Number.isFinite(record.startedAt) ? record.startedAt : undefined,
    finishedAt: typeof record?.finishedAt === 'number' && Number.isFinite(record.finishedAt) ? record.finishedAt : undefined,
  }
}

/** The background-job registry, when the composition mounts one. */
export interface JobDirectory {
  list(caller: SessionId): readonly JobSummary[]
  read(caller: SessionId, id: string): { readonly text: string; readonly snapshot: JobSummary | undefined } | undefined
  kill(caller: SessionId, id: string): 'requested' | 'already-finished' | undefined
  /** Watch for changes; the callback receives the owner the change belongs to. */
  watch(listener: (owner: SessionId | undefined) => void): () => void
}

/**
 * Wrap the job registry.
 *
 * Jobs are live process state rather than durable events, so this is the one
 * part of the surface a resume cannot reconstruct: the dock shows what this
 * run started, and says so by simply being empty afterwards.
 *
 * Forward the driven session ID because the registry authorizes callers by
 * session, not Agent identity. Preserve change owners so the watcher ignores other
 * sessions without losing ownerless refreshes.
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
      // UI reads must not advance the model's output cursor or consume its completion result.
      const result = asRecord(registry.readAt?.(id, JOB_OUTPUT_START_OFFSET, caller))
      if (result === undefined) return undefined
      const chunks = Array.isArray(result.chunks) ? result.chunks : []
      return {
        text: chunks.map(chunk => asRecord(chunk)?.text).filter((text): text is string => typeof text === 'string').join(''),
        snapshot: toSummary(registry.get?.(id, caller)),
      }
    },
    kill: (caller, id) => {
      const outcome = registry.kill?.(id, caller, 'killed from the terminal')
      return outcome === 'requested' || outcome === 'already-finished' ? outcome : undefined
    },
    watch: listener => {
      if (typeof registry.events?.subscribe !== 'function') return () => {}
      return registry.events.subscribe({ owners: 'all' }, event => {
        const record = asRecord(event)
        const owner = record?.owner ?? asRecord(record?.job)?.owner
        if (owner === undefined || typeof owner === 'string') listener(owner as SessionId | undefined)
      })
    },
  }
}
