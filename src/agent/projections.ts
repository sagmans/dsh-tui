import type { Context } from '@deepseek-ai/cordis'

/** The projection registry, described structurally. */
interface Projections {
  stateOf?(session: unknown, key: string): unknown
}

/** One projection read that keeps "not registered" apart from "cannot answer". */
export type ProjectionRead =
  | { readonly kind: 'state'; readonly state: unknown }
  | { readonly kind: 'unregistered' }
  | { readonly kind: 'unavailable' }

/**
 * One session projection's state, with the reason a missing answer is kept.
 *
 * `stateOf` answers `undefined` only for a key that is not registered; a
 * composition without a registry, and a registered unit that throws, are the
 * two cases that leave nothing to read at all. A caller that merely decorates a
 * screen may collapse them, but one deciding whether it knows enough to speak
 * must be able to tell them apart.
 */
export function projectionRead(ctx: Context, session: unknown, key: string): ProjectionRead {
  const projections = ctx.get('sessionProjections') as Projections | undefined
  if (projections?.stateOf === undefined) return { kind: 'unavailable' }
  try {
    const state = projections.stateOf(session, key)
    return state === undefined ? { kind: 'unregistered' } : { kind: 'state', state }
  } catch {
    return { kind: 'unavailable' }
  }
}

/**
 * One session projection's state, or `undefined` whenever there is none to read.
 *
 * The surface reads projections while rendering, where a missing fact may cost a
 * segment but never the session, so every unreadable case collapses here.
 */
export function projectionState(ctx: Context, session: unknown, key: string): unknown {
  const read = projectionRead(ctx, session, key)
  return read.kind === 'state' ? read.state : undefined
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
