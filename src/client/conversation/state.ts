import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-runtime/client'
import {
  boundedJson,
  contentText,
  EVENT_PRIORITY,
  eventType,
  numberField,
  record,
  stringField,
  VIEW_TARGET,
  viewNode,
} from './shared.js'

export const compactionDefinition: ConversationNodeDefinition<{
  readonly seq: number
  readonly text: string
}> = {
  kind: 'tui-compaction',
  target: VIEW_TARGET,
  match: (event) => {
    if (eventType(event) !== 'compaction/summary') return null
    const data: unknown = event.data
    const compactionId = stringField(data, 'compactionId') ?? String(event.seq)
    return { id: `${compactionId}:${event.seq}`, role: 'start' }
  },
  start: (_context, match) => {
    if (eventType(match.event) !== 'compaction/summary') throw new Error('tui compaction requires compaction/summary')
    const data: unknown = match.event.data
    const summary = contentText(record(data) ? data.summary : undefined)
    return { seq: match.event.seq, text: `[history compacted]\n${summary}` }
  },
  update: context => context.state,
  buildViewNode: context => context.state === undefined
    ? null
    : viewNode(context, context.state.seq, `compaction:${context.id}`, EVENT_PRIORITY, 'system', context.state.text),
}

export const retryDefinition: ConversationNodeDefinition<{
  readonly retry: number
  readonly seq: number
  readonly text: string
}> = {
  kind: 'tui-model-retry',
  target: VIEW_TARGET,
  match: event => event.type === 'llm/retry'
    ? { id: `${String(event.data.retryId)}:${event.data.retry}`, role: 'start' }
    : null,
  start: (_context, match) => {
    if (match.event.type !== 'llm/retry') throw new Error('tui retry requires llm/retry')
    const delay = numberField(match.event.data, 'delayMs')
    const message = stringField(match.event.data, 'message')
      ?? stringField(match.event.data.failure, 'message')
    return {
      retry: match.event.data.retry,
      seq: match.event.seq,
      text: `model retry ${match.event.data.retry}${delay === undefined ? '' : ` in ${delay}ms`}${message === undefined ? '' : ` · ${message}`}`,
    }
  },
  update: context => context.state,
  buildViewNode: context => context.state === undefined
    ? null
    : viewNode(context, context.state.seq, `retry:${context.id}`, EVENT_PRIORITY, 'system', context.state.text),
}

export const turnEndDefinition: ConversationNodeDefinition<{
  readonly kind: 'error' | 'system'
  readonly seq: number
  readonly text: string
}> = {
  kind: 'tui-turn-end',
  target: VIEW_TARGET,
  match: event => event.type === 'turn/end' && event.data.reason.kind !== 'completed'
    ? { id: `${event.data.turn}:${event.seq}`, role: 'start' }
    : null,
  start: (_context, match) => {
    if (match.event.type !== 'turn/end') throw new Error('tui turn end requires turn/end')
    const reason = match.event.data.reason
    switch (reason.kind) {
      case 'error': return {
        kind: 'error',
        seq: match.event.seq,
        text: stringField(reason.error, 'message') ?? boundedJson(reason.error),
      }
      case 'max-tokens': return { kind: 'error', seq: match.event.seq, text: 'Maximum output tokens reached.' }
      case 'aborted': return { kind: 'system', seq: match.event.seq, text: 'Turn stopped.' }
      case 'blocked': return { kind: 'error', seq: match.event.seq, text: 'Turn blocked.' }
      case 'interrupted': return { kind: 'error', seq: match.event.seq, text: 'Turn interrupted.' }
      case 'completed': return { kind: 'system', seq: match.event.seq, text: 'Turn completed.' }
      default: return { kind: 'error', seq: match.event.seq, text: boundedJson(reason) }
    }
  },
  update: context => context.state,
  buildViewNode: context => context.state === undefined
    ? null
    : viewNode(context, context.state.seq, `turn-end:${context.id}`, EVENT_PRIORITY, context.state.kind, context.state.text),
}

export const todoDefinition: ConversationNodeDefinition<{
  readonly seq: number
  readonly text: string
}> = {
  kind: 'tui-todos',
  target: VIEW_TARGET,
  match: event => event.type === 'todo/write' ? { id: String(event.seq), role: 'start' } : null,
  start: (_context, match) => {
    if (match.event.type !== 'todo/write') throw new Error('tui todos require todo/write')
    const todos = match.event.data.todos.map(todo => `[${todo.status === 'completed' ? 'x' : todo.status === 'in_progress' ? '>' : ' '}] ${todo.content}`)
    return { seq: match.event.seq, text: todos.length === 0 ? 'Todos cleared.' : `Todos\n${todos.join('\n')}` }
  },
  update: context => context.state,
  buildViewNode: context => context.state === undefined
    ? null
    : viewNode(context, context.state.seq, 'todos', EVENT_PRIORITY, 'system', context.state.text, 'todos'),
}

export const requestHeaderDefinition: ConversationNodeDefinition<{
  readonly seq: number
  readonly text: string
}> = {
  kind: 'tui-request-header',
  target: VIEW_TARGET,
  match: event => event.type === 'request/header' ? { id: String(event.seq), role: 'start' } : null,
  start: (_context, match) => {
    if (match.event.type !== 'request/header') throw new Error('tui request header requires request/header')
    const config = match.event.data.header.config
    return {
      seq: match.event.seq,
      text: `model ${config.provider}/${config.model}${config.reasoningEffort === undefined ? '' : ` · ${config.reasoningEffort}`}`,
    }
  },
  update: context => context.state,
  buildViewNode: context => context.state === undefined
    ? null
    : viewNode(context, context.state.seq, 'request-header', EVENT_PRIORITY, 'system', context.state.text, 'request-header'),
}

export const requestContextDefinition: ConversationNodeDefinition<{
  readonly seq: number
  readonly text: string
}> = {
  kind: 'tui-request-context',
  target: VIEW_TARGET,
  match: event => event.type === 'request/context' ? { id: String(event.seq), role: 'start' } : null,
  start: (_context, match) => {
    if (match.event.type !== 'request/context') throw new Error('tui request context requires request/context')
    const window = match.event.data.contextWindow
    return {
      seq: match.event.seq,
      text: `context ${match.event.data.provider}/${match.event.data.model}${window === undefined ? '' : ` · ${window} tokens`}`,
    }
  },
  update: context => context.state,
  buildViewNode: context => context.state === undefined
    ? null
    : viewNode(context, context.state.seq, 'request-context', EVENT_PRIORITY, 'context', context.state.text, 'request-context'),
}
