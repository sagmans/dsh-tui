import type {
  ConversationNodeContext,
  ConversationNodeDefinition,
  ConversationTimelineSnapshot,
  ConversationViewBuilder,
  ConversationViewDefinition,
  ConversationViewNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ConversationLine,
  ConversationLineKind,
  TuiConversationViewSnapshot,
} from '../../features/conversation/contracts.js'
import type { ToolPresentation } from '../../features/tools/contracts.js'
import { sanitizeConversationText } from '../../features/conversation/projection.js'
import { sanitizeText } from '../../features/sessions/projection.js'

export const VIEW_TARGET = 'tui'
export const EMPTY_TEXT = '(empty)'
export const IMAGE_TEXT = '[image]'
export const MAIN_PRIORITY = 3
export const FALLBACK_PRIORITY = 2
export const EVENT_PRIORITY = 1
const MAX_JSON_LENGTH = 2_000
const MAX_USAGE_FIELDS = 4
const EMPTY_VIEW: TuiConversationViewSnapshot = Object.freeze({
  lines: Object.freeze([]),
  tools: Object.freeze([]),
})

interface TuiConversationNodeData {
  readonly anchorSeq: number
  readonly latestGroup?: string
  readonly line: ConversationLine
  readonly logicalKey: string
  readonly priority: number
  readonly tool?: ToolPresentation
}

export interface TuiConversationViewNode extends ConversationViewNode {
  readonly target: typeof VIEW_TARGET
  readonly data: TuiConversationNodeData
}

export function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null
}

export function eventType(event: { readonly type: unknown }): string {
  return typeof event.type === 'string' ? event.type : ''
}

export function stringField(value: unknown, key: string): string | undefined {
  if (!record(value)) return undefined
  const field = value[key]
  return typeof field === 'string' ? field : undefined
}

export function numberField(value: unknown, key: string): number | undefined {
  if (!record(value)) return undefined
  const field = value[key]
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined
}

export function boundedJson(value: unknown): string {
  let serialized: string
  try {
    serialized = JSON.stringify(value) ?? String(value)
  } catch {
    serialized = String(value)
  }
  const safe = sanitizeText(serialized)
  return safe.length <= MAX_JSON_LENGTH ? safe : `${safe.slice(0, MAX_JSON_LENGTH)}…`
}

export function contentText(content: unknown): string {
  if (!Array.isArray(content)) return boundedJson(content)
  const parts = content.map((block): string => {
    if (!record(block)) return boundedJson(block)
    switch (block.type) {
      case 'text': return typeof block.text === 'string' ? block.text : EMPTY_TEXT
      case 'reasoning': return `thinking: ${typeof block.text === 'string' ? block.text : EMPTY_TEXT}`
      case 'image': return IMAGE_TEXT
      case 'tool-call': {
        const name = typeof block.name === 'string' ? block.name : 'unknown'
        const args = typeof block.arguments === 'string' ? block.arguments : boundedJson(block.arguments)
        return `tool ${name}: ${args}`
      }
      case 'tool-result': return contentText(block.content)
      default: return boundedJson(block)
    }
  })
  const text = sanitizeConversationText(parts.join('\n')).trim()
  return text === '' ? EMPTY_TEXT : text
}

export function sourceLabel(source: unknown): string {
  const kind = stringField(source, 'kind') ?? 'context'
  if (kind === 'user') return 'user'
  return stringField(source, 'plugin') ?? stringField(source, 'name') ?? kind
}

export function usageText(usage: unknown): string {
  if (!record(usage)) return ''
  const fields = Object.entries(usage)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && /token/iu.test(entry[0]))
    .slice(0, MAX_USAGE_FIELDS)
    .map(([key, value]) => `${key.replace(/Tokens?$/u, '')}:${value}`)
  return fields.length === 0 ? '' : ` · ${fields.join(' ')}`
}

export function viewNode(
  context: ConversationNodeContext,
  anchorSeq: number,
  logicalKey: string,
  priority: number,
  kind: ConversationLineKind,
  text: string,
  latestGroup?: string,
  tool?: ToolPresentation,
): TuiConversationViewNode {
  return {
    key: context.key,
    kind: context.kind,
    id: context.id,
    target: VIEW_TARGET,
    data: {
      anchorSeq,
      line: Object.freeze({ key: logicalKey, kind, text: sanitizeConversationText(text) }),
      logicalKey,
      priority,
      ...latestGroup === undefined ? {} : { latestGroup },
      ...tool === undefined ? {} : { tool },
    },
  }
}

class TuiConversationSnapshotBuilder implements ConversationViewBuilder<TuiConversationViewNode, TuiConversationViewSnapshot> {
  private readonly nodes = new Map<string, TuiConversationViewNode>()
  readonly empty = EMPTY_VIEW

  replace(input: {
    readonly nodes: readonly TuiConversationViewNode[]
    readonly timeline: ConversationTimelineSnapshot
  }): TuiConversationViewSnapshot {
    this.nodes.clear()
    for (const node of input.nodes) this.nodes.set(node.key, node)
    return this.snapshot()
  }

  apply(input: {
    readonly upserts: readonly TuiConversationViewNode[]
    readonly timeline: ConversationTimelineSnapshot
  }): TuiConversationViewSnapshot {
    for (const node of input.upserts) this.nodes.set(node.key, node)
    return this.snapshot()
  }

  private snapshot(): TuiConversationViewSnapshot {
    const latest = new Map<string, TuiConversationViewNode>()
    for (const node of this.nodes.values()) {
      const group = node.data.latestGroup
      if (group === undefined) continue
      const previous = latest.get(group)
      if (previous === undefined || previous.data.anchorSeq < node.data.anchorSeq) latest.set(group, node)
    }
    const selected = new Map<string, TuiConversationViewNode>()
    for (const node of this.nodes.values()) {
      const group = node.data.latestGroup
      if (group !== undefined && latest.get(group) !== node) continue
      const previous = selected.get(node.data.logicalKey)
      if (previous === undefined
        || previous.data.priority < node.data.priority
        || (previous.data.priority === node.data.priority && previous.data.anchorSeq < node.data.anchorSeq)) {
        selected.set(node.data.logicalKey, node)
      }
    }
    const ordered = [...selected.values()]
      .toSorted((left, right) => left.data.anchorSeq - right.data.anchorSeq || left.key.localeCompare(right.key))
    const lines = ordered.map(node => node.data.line)
    const tools = ordered.flatMap(node => node.data.tool === undefined ? [] : [node.data.tool])
    return Object.freeze({ lines: Object.freeze(lines), tools: Object.freeze(tools) })
  }
}

export const unknownFallbackDefinition: ConversationNodeDefinition<{
  readonly seq: number
  readonly text: string
}> = {
  kind: 'tui-unknown-surface',
  target: VIEW_TARGET,
  match: event => (event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result')
    && event.surfaceOp === 'append'
    ? { id: String(event.seq), role: 'start' }
    : null,
  start: (_context, match) => ({ seq: match.event.seq, text: `${match.event.type}\n${boundedJson(match.event.data)}` }),
  update: context => context.state,
  buildViewNode: context => context.state === undefined
    ? null
    : viewNode(context, context.state.seq, `unknown:${context.id}`, EVENT_PRIORITY, 'system', context.state.text),
}

export const tuiConversationViewDefinition: ConversationViewDefinition<
  TuiConversationViewNode,
  TuiConversationViewSnapshot
> = {
  target: VIEW_TARGET,
  create: () => new TuiConversationSnapshotBuilder(),
}
