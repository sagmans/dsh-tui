import { SessionId } from '@deepseek-ai/dsh-session'
import type { TuiStartup } from './contracts.ts'

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
export function resolveConfig(raw: unknown): TuiStartup {
  if (typeof raw !== 'object' || raw === null) {
    throw new TuiConfigError('tui row configuration must be a mapping')
  }
  const record = raw as Record<string, unknown>
  return {
    sessionId: SessionId(requireString(record.sessionId, 'sessionId')),
    resume: optionalBoolean(record.resume, 'resume', false),
    resumePicker: optionalBoolean(record.resumePicker, 'resumePicker', false),
    model: optionalString(record.model, 'model'),
    provider: optionalString(record.provider, 'provider'),
    color: optionalBoolean(record.color, 'color', true),
  }
}
