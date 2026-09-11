import type { Context } from '@deepseek-ai/cordis'
import type { PickerRow } from '../ui/picker.ts'
import { projectionRecord, projectionString } from './projections.ts'

/**
 * The roster of agent compositions, and the mode one session runs.
 *
 * A preset is the plugin composition an agent's own scope joins: its tools,
 * prompt sections, skills, and planning rows. The session header records the
 * one it started with, a switch while the session is still blank is recorded as
 * a `agent-preset/selected` event, and the `agentPreset` projection is the
 * answer every reader resolves — the header alone is not.
 */

/** One preset as the roster publishes it. */
export interface PresetSummary {
  readonly id: string
  readonly trust: 'system' | 'user'
  /** Display text the preset itself published, when it published any. */
  readonly name: string | undefined
  readonly description: string | undefined
  /** Why this preset cannot compose a session, absent when it can. */
  readonly broken: string | undefined
}

/** What a `/preset` argument asks the surface to do. */
export type PresetCommand =
  | { readonly kind: 'pick' }
  | { readonly kind: 'switch'; readonly id: string }

/**
 * Read a `/preset` argument.
 *
 * A bare command opens the picker because choosing by eye is the point of a
 * selector; anything else is an id, which is the token the session log records.
 */
export function parsePresetArgument(argument: string): PresetCommand {
  const id = argument.trim()
  return id === '' ? { kind: 'pick' } : { kind: 'switch', id }
}

/**
 * One-line gloss for the modes this deployment ships.
 *
 * The Web app translates the same four ids from its own locale bundle; a
 * terminal has no such bundle, so the copy lives here. A preset this table does
 * not name is not ours to describe: it speaks for itself through its metadata.
 */
const SHIPPED_GLOSS: Readonly<Record<string, string>> = {
  standard: 'full agent: editing, shell, search, skills, planning, goals, subagents, workflows',
  ptc: 'the same agent, with its tools reached through one TypeScript program',
  minimal: 'one tool: a persistent shell',
  cordis: 'harness authoring: runtime inspection and composition guidance',
}

/** How one preset appears in the picker. */
export function describePreset(preset: PresetSummary, currentId: string | undefined): PickerRow {
  const gloss = SHIPPED_GLOSS[preset.id]
  const described = preset.broken !== undefined
    ? `cannot start: ${preset.broken}`
    : [gloss ?? preset.name, gloss === undefined ? preset.description : undefined,
        preset.trust === 'user' ? 'authored here' : undefined]
        .filter(part => part !== undefined && part !== '')
        .join(' · ')
  return {
    label: preset.id,
    description: described === '' ? undefined : described,
    current: preset.id === currentId,
  }
}

/** The roster this surface reads, described structurally. */
export interface PresetRoster {
  /** The preset a session starts on when nobody names one. */
  readonly defaultId: string
  list(): Promise<readonly PresetSummary[]>
  resolve(id: string | undefined): Promise<PresetSummary>
  /**
   * Join one unpublished agent scope to its preset.
   *
   * A rejection here rolls the whole agent creation back, so a preset that
   * cannot compose never yields a half-configured session.
   */
  mount(agentCtx: Context, id: string): Promise<void>
  /** Compose a blank session's agent from another preset and record it. */
  select(agent: unknown, id: string): Promise<string>
  /** The preset one live session runs, from its own projection. */
  current(session: unknown): string | undefined
  /**
   * Whether a session has produced a turn, which is what fixes its preset.
   *
   * Read as the harness reads it, and only to keep the picker from offering a
   * choice that would be refused: {@link PresetRoster.select} remains the
   * authority, because a session can start between this read and the switch.
   */
  started(session: unknown): boolean
}

/** The projection key the roster advances and this surface reads. */
export const AGENT_PRESET_KEY = 'agentPreset'

/** The projection key a session's turn boundary lives under. */
const TURN_BOUNDARY_KEY = 'turnBoundary'

/** The roster service, described structurally. */
interface RosterService {
  readonly defaultId?: unknown
  list?(): Promise<readonly unknown[]>
  resolve?(id?: string): Promise<unknown>
  mount?(agentCtx: Context, id?: string): Promise<unknown>
  select?(agent: unknown, id: string): Promise<string>
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function textOr(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** One roster row, or undefined when it names no usable id. */
function toSummary(value: unknown): PresetSummary | undefined {
  const record = asRecord(value)
  const id = textOr(record?.id)
  if (id === undefined) return undefined
  return {
    id,
    trust: record?.trust === 'user' ? 'user' : 'system',
    name: textOr(record?.name),
    description: textOr(record?.description),
    broken: textOr(record?.broken),
  }
}

function numberOr(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Wrap the roster in the little of it a terminal needs.
 *
 * The seam is optional here: a composition that dropped the row still runs the
 * surface, it just has no mode to choose. Every call is guarded because the
 * service arrives from another package and its shape is this surface's
 * assumption, not its contract.
 */
export function createPresetRoster(ctx: Context): PresetRoster | undefined {
  const service = ctx.get('agentPresets') as RosterService | undefined
  if (typeof service?.list !== 'function' || typeof service.mount !== 'function') return undefined
  const defaultId = textOr(service.defaultId)
  if (defaultId === undefined) return undefined
  return {
    defaultId,
    list: async () => {
      const rows = await service.list?.() ?? []
      return rows.flatMap(row => toSummary(row) ?? [])
    },
    resolve: async id => {
      const resolved = await service.resolve?.(id)
      const summary = toSummary(resolved)
      if (summary === undefined) {
        throw new Error(`agentPresets: the roster resolved ${id === undefined ? 'its default' : `"${id}"`} to nothing usable`)
      }
      return summary
    },
    mount: async (agentCtx, id) => {
      await service.mount?.(agentCtx, id)
    },
    select: async (agent, id) => {
      const select = service.select
      if (typeof select !== 'function') throw new Error('agentPresets: this roster cannot switch a session')
      return await select.call(service, agent, id)
    },
    current: session => projectionString(ctx, session, AGENT_PRESET_KEY),
    started: session => {
      const boundary = projectionRecord(ctx, session, TURN_BOUNDARY_KEY)
      if (boundary === undefined) return false
      const open = boundary.openTurnStartSeq
      if (open !== null && open !== undefined) return true
      return (numberOr(boundary.lastTurn) ?? 0) > 0
    },
  }
}
