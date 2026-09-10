import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { StatusFacts } from '../ui/status.ts'

/** Whether a turn is running and when it started. */
export interface ActivityState {
  readonly running: boolean
  readonly startedAt: number | undefined
}

/** The default-model directory, described structurally. */
interface ModelDirectory {
  currentSelection?(): { readonly provider?: string; readonly model?: string; readonly reasoningEffort?: string }
}

/** The session registry, described structurally. */
interface SessionRegistry {
  get?(id: SessionId): unknown
}

/** The permission-preset directory, described structurally. */
interface PresetDirectory {
  current?(session: unknown): string
}

/** The work-state projection registry, described structurally. */
interface Projections {
  stateOf?(session: unknown, key: string): unknown
}

/**
 * The token-usage projection state.
 *
 * The unit projects `{ totals, last }` — a flat usage object is the wrong shape
 * and reading it silently yields nothing, so the reader is pinned by a test.
 */
export function usageTotals(state: unknown): Record<string, unknown> | undefined {
  return asRecord(asRecord(state)?.totals)
}

/**
 * Share of prompt tokens a provider served from cache.
 *
 * Read tokens against the uncached ones: a hit rate is what a reader can act on
 * (it is what caching buys), while the raw counts belong in `/status`.
 */
export function cacheRate(usage: Record<string, unknown> | undefined): number | undefined {
  const read = numberOr(usage?.cacheReadTokens)
  const uncached = numberOr(usage?.uncachedInputTokens)
  if (read === undefined || uncached === undefined) return undefined
  const total = read + uncached
  return total === 0 ? undefined : read / total
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function numberOr(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Gather what the footer states.
 *
 * Every service is optional and every read is guarded: the footer is the least
 * important thing on screen, and a composition that omits the model directory or
 * the token meter should cost the reader a segment, not the session.
 */
/** Where the footer reads its facts from. */
export interface StatusSources {
  readonly sessionId: () => SessionId
  readonly activity: () => ActivityState
  /**
   * A route the reader chose for this session, which outranks the composition
   * default: the footer must show the model the next step will actually use.
   */
  readonly override?: (() => {
    readonly provider?: string
    readonly model?: string
    readonly reasoningEffort?: string
  } | undefined) | undefined
  readonly home?: string | undefined
}

export function createStatusFacts(ctx: Context, sources: StatusSources): () => StatusFacts {
  const projection = (session: unknown, key: string): Record<string, unknown> | undefined => {
    const projections = ctx.get('sessionProjections') as Projections | undefined
    if (projections?.stateOf === undefined) return undefined
    try {
      return asRecord(projections.stateOf(session, key))
    } catch {
      // A projection that is not composed for this session is simply absent.
      return undefined
    }
  }
  return () => {
    const override = sources.override?.()
    const selection = override ?? (ctx.get('agentDefaultModel') as ModelDirectory | undefined)?.currentSelection?.()
    const session = (ctx.get('sessions') as SessionRegistry | undefined)?.get?.(sources.sessionId())
    let preset: string | undefined
    if (session !== undefined) {
      try {
        preset = (ctx.get('permissionPresets') as PresetDirectory | undefined)?.current?.(session)
      } catch {
        preset = undefined
      }
    }
    const pressure = session === undefined ? undefined : projection(session, 'contextPressure')
    const totals = session === undefined ? undefined : usageTotals(projection(session, 'tokenUsage'))
    const state = sources.activity()
    return {
      activity: state.running ? 'working' : 'idle',
      elapsedMs: state.startedAt === undefined ? undefined : Date.now() - state.startedAt,
      provider: selection?.provider,
      model: selection?.model,
      effort: selection?.reasoningEffort,
      preset,
      contextTokens: numberOr(pressure?.pressureTokens),
      contextWindow: numberOr(pressure?.contextWindow),
      cacheRate: cacheRate(totals),
      uncachedInputTokens: numberOr(totals?.uncachedInputTokens),
      outputTokens: numberOr(totals?.outputTokens),
      cwd: process.cwd(),
      home: sources.home,
    }
  }
}
