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
  currentSelection?(): { readonly model?: string; readonly reasoningEffort?: string }
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
export function createStatusFacts(
  ctx: Context,
  sessionId: () => SessionId,
  activity: () => ActivityState,
  home: string | undefined,
): () => StatusFacts {
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
    const selection = (ctx.get('agentDefaultModel') as ModelDirectory | undefined)?.currentSelection?.()
    const session = (ctx.get('sessions') as SessionRegistry | undefined)?.get?.(sessionId())
    let preset: string | undefined
    if (session !== undefined) {
      try {
        preset = (ctx.get('permissionPresets') as PresetDirectory | undefined)?.current?.(session)
      } catch {
        preset = undefined
      }
    }
    const pressure = session === undefined ? undefined : projection(session, 'contextPressure')
    const state = activity()
    return {
      activity: state.running ? 'working' : 'idle',
      elapsedMs: state.startedAt === undefined ? undefined : Date.now() - state.startedAt,
      model: selection?.model,
      effort: selection?.reasoningEffort,
      preset,
      contextTokens: numberOr(pressure?.pressureTokens),
      contextWindow: numberOr(pressure?.contextWindow),
      cwd: process.cwd(),
      home,
    }
  }
}
