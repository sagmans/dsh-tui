import type { Context } from '@deepseek-ai/cordis'
import type { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { isLocalProducedPath } from './projection.js'

const FILE_REFERENCE_SECTION = 'ui:deliverable-file-references'
const FILE_REFERENCE_ORDER = 190
const FILE_REFERENCE_PROMPT = 'When you successfully create or modify files, mention the primary outputs in your final response. '
  + 'For terminal discovery, format changed-file references as Markdown inline code using the exact file-tool path, or a basename when unique among files changed in that turn. '
  + 'The terminal keeps prose mentions inert and exposes verified local tool locations separately for confirmed opening.'
const FORWARD_SLASH = '/'
const BACKSLASH = '\\'

export const name = 'tui-deliverables'
export const inject: readonly string[] = ['systemPrompt']

function basename(path: string): string {
  const separator = Math.max(path.lastIndexOf(FORWARD_SLASH), path.lastIndexOf(BACKSLASH))
  return separator < 0 ? path : path.slice(separator + 1)
}

export function resolveProducedMention(paths: readonly string[], value: string): string | undefined {
  if (!isLocalProducedPath(value)) return undefined
  const exact = paths.find(path => path === value)
  if (exact !== undefined) return exact
  const matches = paths.filter(path => isLocalProducedPath(path) && basename(path) === value)
  return matches.length === 1 ? matches[0] : undefined
}

export function apply(ctx: Context): void {
  const systemPrompt: SystemPrompt = ctx.systemPrompt
  systemPrompt.section({
    name: FILE_REFERENCE_SECTION,
    order: FILE_REFERENCE_ORDER,
    text: FILE_REFERENCE_PROMPT,
  })
}
