import { SessionId } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import { TuiSettingsSchema } from './theme-settings.ts'
import type { TuiRowConfig } from './contracts.ts'

/** Native references distinguish live Config from ordinary released schema output. */
const VOLATILE_REFERENCE = Symbol.for('cosmokit.volatile.write')
const PREFERENCE_SCHEMA = TuiSettingsSchema.dict!
const PREFERENCE_FIELDS = Object.keys(PREFERENCE_SCHEMA)
const CONFIG_HISTORY = z.object({
  // A source host imports legacy settings after activation; absence is not consent.
  enabled: z.boolean(),
  ghost: z.boolean(),
  maxEntries: PREFERENCE_SCHEMA.history!.dict!.maxEntries!,
})

/** Keep launch identity fixed while source hosts expose preferences as live Config fields. */
export const Config = z.object({
  sessionId: z.string().required(),
  resume: z.boolean().default(false),
  resumePicker: z.boolean().default(false),
  model: z.string(),
  provider: z.string(),
  preset: z.string(),
  color: z.boolean().default(true),
  bell: z.boolean().default(true),
  ...Object.fromEntries(Object.entries(PREFERENCE_SCHEMA).map(([key, schema]) => {
    const field = new z((key === 'history' ? CONFIG_HISTORY : schema).toJSON())
    // False metadata makes source Loader silently skip ordinary config updates.
    const native = field as z & { volatile?: () => z }
    return [key, typeof native.volatile === 'function' ? native.volatile() : field]
  })),
})

/** Only native Config references may execute a getter; ordinary input remains data. */
function preferenceValue(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || !(VOLATILE_REFERENCE in value)) return value
  const reference = value as { get?: () => unknown }
  if (typeof reference.get !== 'function') throw new TuiConfigError('invalid volatile preference reference')
  return reference.get()
}

/** Metadata alone makes source Loader skip remounts; writes require actual native references too. */
export function hasLiveRowSettings(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false
  const record = raw as Record<string, unknown>
  return PREFERENCE_FIELDS.every(key => {
    const value = record[key]
    return typeof value === 'object' && value !== null && VOLATILE_REFERENCE in value
      && typeof Reflect.get(value, 'get') === 'function'
  })
}

/** Preserve raw malformed fields for the appearance owner to diagnose without losing opt-outs. */
export function readRowSettings(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw
  const record = raw as Record<string, unknown>
  return Object.fromEntries(PREFERENCE_FIELDS.flatMap(key => {
    const value = preferenceValue(record[key])
    return value === undefined ? [] : [[key, value]]
  }))
}

/** A composed row whose configuration cannot describe a runnable terminal surface. */
export class TuiConfigError extends Error {}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TuiConfigError(`${field} must be a non-empty string`)
  }
  return value
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new TuiConfigError(`${field} must be a string when present`)
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function optionalBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw new TuiConfigError(`${field} must be a boolean when present`)
  return value
}

/**
 * Validate the row's configuration into the runtime shape.
 *
 * The shipped patch derives every value from the startup service, but a user
 * may hand-configure this row in a profile patch, so the row validates its own
 * input instead of trusting the layer above it.
 */
export function resolveConfig(raw: unknown): TuiRowConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TuiConfigError('tui row configuration must be a mapping')
  }
  const record = raw as Record<string, unknown>
  return {
    sessionId: SessionId(requireString(record.sessionId, 'sessionId')),
    resume: optionalBoolean(record.resume, 'resume', false),
    resumePicker: optionalBoolean(record.resumePicker, 'resumePicker', false),
    model: optionalString(record.model, 'model'),
    provider: optionalString(record.provider, 'provider'),
    preset: optionalString(record.preset, 'preset'),
    theme: optionalString(preferenceValue(record.theme), 'theme'),
    color: optionalBoolean(record.color, 'color', true),
    bell: optionalBoolean(record.bell, 'bell', true),
  }
}
