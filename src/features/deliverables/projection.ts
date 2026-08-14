import type { ToolCallView } from '@deepseek-ai/dsh-api-remotes/client'
import { sanitizeText } from '../sessions/projection.js'

const MAX_PRODUCED_PATHS = 80

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null
}

export function producedPaths(view: ToolCallView | null | undefined, failed: boolean): readonly string[] {
  if (failed || !record(view)) return Object.freeze([])
  const mutation = view.card === 'diff' || (view.card === 'generic' && view.kind === 'edit')
  if (!mutation || !Array.isArray(view.locations)) return Object.freeze([])
  const paths: string[] = []
  const seen = new Set<string>()
  for (const location of view.locations.slice(0, MAX_PRODUCED_PATHS)) {
    if (!record(location) || typeof location.path !== 'string') continue
    const path = sanitizeText(location.path)
    if (path === '' || path !== location.path || seen.has(path)) continue
    seen.add(path)
    paths.push(path)
  }
  return Object.freeze(paths)
}
