import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { StatusFacts } from '../ui/status.ts'
import { AGENT_PRESET_KEY } from './presets.ts'
import { projectionRecord, projectionString } from './projections.ts'

/** Keep the turn clock with its activity so footer paints can compute elapsed time from the live session. */
export interface ActivityState {
  readonly running: boolean
  readonly startedAt: number | undefined
}

/** Keep footer reads limited to selection facts; a composition without this optional directory has no default route facts. */
interface ModelDirectory {
  currentSelection?(): { readonly provider?: string; readonly model?: string; readonly reasoningEffort?: string }
}

/** Only session lookup belongs here; without it, the footer omits session projections and permission facts. */
interface SessionRegistry {
  get?(id: SessionId): unknown
}

/** Read only the active permission label so footer decoration does not depend on the directory's other operations. */
interface PresetDirectory {
  current?(session: unknown): string
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

/** Supply live footer facts without coupling the painter to session services. */
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
  /** Addons qualify the active route without putting provider-specific policy in the painter. */
  readonly routeHints?: (route: { readonly provider: string; readonly model: string }) => readonly string[]
  /**
   * The chord waiting for its next key, read per paint so its window lapses on
   * screen rather than only in the reader's head.
   */
  readonly chord?: (() => string | undefined) | undefined
  /**
  /**
   * The way back to the driven session, read per paint: the reader may remap it
   * or open another session while the row is already on screen.
   */
  readonly back?: (() => string | undefined) | undefined
  /**
   * How many drafts this session has parked, read per paint so the count
   * follows a stash or a pop without the surface having to push an update.
   */
  readonly stash?: (() => number | undefined) | undefined
}

/**
 * Keep footer decoration usable when optional services are absent.
 * Failed permission-preset reads become absent facts; other service methods
 * and source callbacks are not protected from exceptions here.
 */
export function createStatusFacts(ctx: Context, sources: StatusSources): () => StatusFacts {
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
    const pressure = session === undefined ? undefined : projectionRecord(ctx, session, 'contextPressure')
    const totals = session === undefined ? undefined : usageTotals(projectionRecord(ctx, session, 'tokenUsage'))
    const state = sources.activity()
    return {
      activity: state.running ? 'working' : 'idle',
      elapsedMs: state.startedAt === undefined ? undefined : Date.now() - state.startedAt,
      provider: selection?.provider,
      model: selection?.model,
      effort: selection?.reasoningEffort,
      modelHints: selection?.provider !== undefined && selection.model !== undefined
        ? sources.routeHints?.({ provider: selection.provider, model: selection.model }) : undefined,
      agentPreset: session === undefined ? undefined : projectionString(ctx, session, AGENT_PRESET_KEY),
      preset,
      contextTokens: numberOr(pressure?.pressureTokens),
      contextWindow: numberOr(pressure?.contextWindow),
      cacheRate: cacheRate(totals),
      uncachedInputTokens: numberOr(totals?.uncachedInputTokens),
      outputTokens: numberOr(totals?.outputTokens),
      stashed: sources.stash?.(),
      cwd: process.cwd(),
      home: sources.home,
      chord: sources.chord?.(),
      back: sources.back?.(),
    }
  }
}
