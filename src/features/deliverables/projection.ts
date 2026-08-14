import type { ToolCallView } from '@deepseek-ai/dsh-api-remotes/client'
import { sanitizeText } from '../sessions/projection.js'

const URI_SCHEME_PATTERN = /^[A-Za-z][A-Za-z\d+.-]*:/u
const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/u
const NETWORK_PATH_PATTERN = /^[\\/]{2}/u

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null
}

export function isLocalProducedPath(value: string): boolean {
  const path = sanitizeText(value)
  if (path !== value || path.trim() === '' || NETWORK_PATH_PATTERN.test(path)) return false
  return WINDOWS_DRIVE_PATH_PATTERN.test(path) || !URI_SCHEME_PATTERN.test(path)
}

export function producedPaths(view: ToolCallView | null | undefined, failed: boolean): readonly string[] {
  if (failed || !record(view)) return Object.freeze([])
  const mutation = view.card === 'diff' || (view.card === 'generic' && view.kind === 'edit')
  if (!mutation || !Array.isArray(view.locations)) return Object.freeze([])
  const paths: string[] = []
  const seen = new Set<string>()
  for (const location of view.locations) {
    if (!record(location) || typeof location.path !== 'string') continue
    const path = location.path
    if (!isLocalProducedPath(path) || seen.has(path)) continue
    seen.add(path)
    paths.push(path)
  }
  return Object.freeze(paths)
}
