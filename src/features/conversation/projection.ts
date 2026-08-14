import type {
  AssistantBlock,
  CommandNode,
  ContextMessageNode,
  ConversationNode,
  PartialAssistant,
  QueuedMessage,
  RunningToolCall,
  ToolCallBlock,
  ToolResultNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ConversationLine,
  ConversationLineKind,
  ConversationProjectionInput,
} from './contracts.js'
import { sanitizeText } from '../sessions/projection.js'

const EMPTY_TEXT = '(empty)'
const IMAGE_TEXT = '[image]'
const UNKNOWN_TEXT = '[unsupported content]'
const CONTEXT_PREFIX = 'context'
const REASONING_PREFIX = 'thinking'
const TOOL_PREFIX = 'tool'
const QUEUE_PREFIX: Readonly<Record<QueuedMessage['placement'], string>> = Object.freeze({
  context: 'context pending',
  queued: 'queued',
  steering: 'steering',
})
const MAX_JSON_LENGTH = 2_000
const LINE_SEPARATOR = '\n'

type ContentBlock = Extract<ConversationNode, { readonly kind: 'user' }>['content'][number]

export function sanitizeConversationText(value: string): string {
  return value.split(LINE_SEPARATOR).map(part => sanitizeText(part)).join(LINE_SEPARATOR)
}

function boundedJson(value: unknown): string {
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    serialized = String(value)
  }
  const safe = sanitizeText(serialized)
  return safe.length <= MAX_JSON_LENGTH ? safe : `${safe.slice(0, MAX_JSON_LENGTH)}…`
}

function contentText(blocks: readonly ContentBlock[]): string {
  const parts = blocks.map((block) => {
    switch (block.type) {
      case 'text': return block.text
      case 'reasoning': return `${REASONING_PREFIX}: ${block.text}`
      case 'image': return IMAGE_TEXT
      case 'tool-call': return `${TOOL_PREFIX} ${block.name}: ${block.arguments}`
      case 'tool-result': return contentText(block.content)
      default: return UNKNOWN_TEXT
    }
  })
  const text = sanitizeConversationText(parts.join(LINE_SEPARATOR)).trim()
  return text === '' ? EMPTY_TEXT : text
}

function assistantText(blocks: readonly AssistantBlock[]): string {
  const parts = blocks.map((block) => {
    switch (block.kind) {
      case 'text': return block.text
      case 'reasoning': return `${REASONING_PREFIX}: ${block.text}`
      case 'image': return IMAGE_TEXT
      case 'tool-call': return `${TOOL_PREFIX} ${block.name}: ${block.argsRaw}`
      case 'other': return boundedJson(block.block)
      default: {
        const exhaustive: never = block
        return String(exhaustive)
      }
    }
  })
  const text = sanitizeConversationText(parts.join(LINE_SEPARATOR)).trim()
  return text === '' ? EMPTY_TEXT : text
}

function commandText(node: CommandNode): string {
  const name = node.name ?? 'unknown'
  const args = node.args ?? ''
  const outcome = node.outcome === null
    ? 'running'
    : node.outcome.text ?? node.outcome.kind
  return `/${sanitizeText(name)}${sanitizeText(args)} · ${sanitizeConversationText(outcome)}`
}

function contextText(node: ContextMessageNode): string {
  const label = node.provenance.label ?? node.provenance.role
  return `${CONTEXT_PREFIX} ${sanitizeText(label)}: ${contentText(node.content)}`
}

function toolResultText(node: ToolResultNode): string {
  const name = node.call?.name ?? node.callId
  const status = node.isError ? 'error' : 'done'
  return `${TOOL_PREFIX} ${sanitizeText(name)} · ${status}${LINE_SEPARATOR}${contentText(node.content)}`
}

function finalizedLine(node: ConversationNode): ConversationLine {
  switch (node.kind) {
    case 'user': return line(`node:${node.seq}`, 'user', contentText(node.content))
    case 'steering': return line(`node:${node.seq}`, 'user', `steer: ${contentText(node.content)}`)
    case 'context': return line(`node:${node.seq}`, 'context', contextText(node))
    case 'assistant': return line(
      `node:${node.seq}`,
      'assistant',
      `${assistantText(node.blocks)}${node.interrupted === true ? '\n[stopped]' : ''}`,
    )
    case 'tool-result': return line(`node:${node.seq}`, 'tool', toolResultText(node))
    case 'command': return line(`node:${node.seq}`, 'command', commandText(node))
    case 'compaction': return line(
      `node:${node.seq}`,
      'system',
      node.summary === null ? '[history compacted]' : `[history compacted]\n${sanitizeText(node.summary)}`,
    )
    case 'model-retry': return line(
      `node:${node.seq}`,
      'system',
      `model retry ${node.retry} · ${node.retryState}`,
    )
    case 'turn-error': return line(`node:${node.seq}`, 'error', sanitizeText(node.message))
    case 'turn-max-tokens': return line(`node:${node.seq}`, 'error', 'Maximum output tokens reached.')
    case 'unknown': return line(`node:${node.seq}`, 'system', `${sanitizeText(node.type)}\n${boundedJson(node.data)}`)
    default: {
      const exhaustive: never = node
      throw new Error(`unhandled conversation node: ${String(exhaustive)}`)
    }
  }
}

function line(key: string, kind: ConversationLineKind, text: string): ConversationLine {
  return Object.freeze({ key, kind, text })
}

function runningToolLine(tool: RunningToolCall): ConversationLine {
  return line(`running-tool:${tool.callId}`, 'tool', `${TOOL_PREFIX} ${sanitizeText(tool.name)} · running\n${sanitizeText(tool.argsRaw)}`)
}

function nestedRunning(block: ToolCallBlock): RunningToolCall[] {
  const nested = block.subCalls.flatMap(nestedRunning)
  return 'kind' in block ? nested : [block, ...nested]
}

function partialLine(partial: PartialAssistant): ConversationLine {
  return line(
    `partial:${partial.turn}:${partial.step}`,
    'assistant',
    `${assistantText(partial.blocks)}\n[streaming]`,
  )
}

export function projectConversationLines(input: ConversationProjectionInput): ConversationLine[] {
  const lines = input.nodes.map(finalizedLine)
  if (input.partial !== null) lines.push(partialLine(input.partial))
  for (const tool of input.runningCalls.flatMap(nestedRunning)) lines.push(runningToolLine(tool))
  return lines
}

export function projectQueuedLines(queue: readonly QueuedMessage[]): ConversationLine[] {
  return queue.map(item => line(
    `queue:${String(item.id)}`,
    item.placement === 'context' ? 'context' : 'user',
    `${QUEUE_PREFIX[item.placement]}: ${sanitizeText(item.preview)}`,
  ))
}
