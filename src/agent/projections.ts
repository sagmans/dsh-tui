import type { Context } from '@deepseek-ai/cordis'

/** The projection registry, described structurally. */
interface Projections {
  stateOf?(session: unknown, key: string): unknown
}

/**
 * One session projection's state.
 *
 * A composition without a projection registry, and a session whose projection
 * unit is not registered, both leave the key simply absent — and the surface
 * reads projections while rendering, where a missing fact may cost a segment
 * but never the session. A registered unit that throws is treated the same way
 * for the same reason.
 */
export function projectionState(ctx: Context, session: unknown, key: string): unknown {
  const projections = ctx.get('sessionProjections') as Projections | undefined
  if (projections?.stateOf === undefined) return undefined
  try {
    return projections.stateOf(session, key)
  } catch {
    return undefined
  }
}

/** One projection's state when it is a record. */
export function projectionRecord(
  ctx: Context,
  session: unknown,
  key: string,
): Record<string, unknown> | undefined {
  const state = projectionState(ctx, session, key)
  return typeof state === 'object' && state !== null ? state as Record<string, unknown> : undefined
}

/** One projection's state when it is a non-empty string. */
export function projectionString(ctx: Context, session: unknown, key: string): string | undefined {
  const state = projectionState(ctx, session, key)
  return typeof state === 'string' && state !== '' ? state : undefined
}
