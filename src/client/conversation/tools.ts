import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-runtime/client'
import {
  boundedJson,
  contentText,
  FALLBACK_PRIORITY,
  MAIN_PRIORITY,
  record,
  VIEW_TARGET,
  viewNode,
} from './shared.js'

interface ToolState {
  readonly args: string
  readonly callId: string
  readonly name: string
  readonly result: string | undefined
  readonly resultError: boolean
}

interface CommandState {
  readonly args: string
  readonly commandId: string
  readonly name: string
  readonly outcome: string | undefined
}

function toolResult(message: unknown): { readonly error: boolean; readonly text: string } {
  if (!record(message) || !Array.isArray(message.content)) return { error: false, text: boundedJson(message) }
  const content: readonly unknown[] = message.content
  const block: unknown = content[0]
  if (!record(block)) return { error: false, text: boundedJson(block) }
  return { error: block.isError === true, text: contentText(block.content) }
}

export const toolDefinition: ConversationNodeDefinition<ToolState> = {
  kind: 'tui-tool-call',
  target: VIEW_TARGET,
  match: (event) => {
    if (event.type === 'tool/call') return { id: String(event.data.callId), role: 'start' }
    if (event.type === 'tool/result' && event.surfaceOp === 'append') {
      return { id: String(event.data.message.source.callId), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'tool/call') throw new Error('tui tool call requires tool/call')
    return {
      args: match.event.data.arguments,
      callId: String(match.event.data.callId),
      name: match.event.data.name,
      result: undefined,
      resultError: false,
    }
  },
  update: (context, match) => {
    if (match.event.type !== 'tool/result') return context.state
    const result = toolResult(match.event.data.message)
    return { ...context.state, result: result.text, resultError: result.error }
  },
  buildViewNode: (context) => {
    const state = context.state
    if (state === undefined) return null
    const status = state.result === undefined ? 'running' : state.resultError ? 'error' : 'done'
    const body = state.result ?? state.args
    return viewNode(
      context,
      context.start?.event.seq ?? 0,
      `tool:${state.callId}`,
      MAIN_PRIORITY,
      'tool',
      `${state.name} · ${status}\n${body}`,
    )
  },
}

export const toolFallbackDefinition: ConversationNodeDefinition<{
  readonly callId: string
  readonly error: boolean
  readonly seq: number
  readonly text: string
}> = {
  kind: 'tui-tool-result',
  target: VIEW_TARGET,
  match: event => event.type === 'tool/result' && event.surfaceOp === 'append'
    ? { id: `${String(event.data.message.source.callId)}:${event.seq}`, role: 'start' }
    : null,
  start: (_context, match) => {
    if (match.event.type !== 'tool/result') throw new Error('tui tool result requires tool/result')
    const result = toolResult(match.event.data.message)
    return {
      callId: String(match.event.data.message.source.callId),
      error: result.error,
      seq: match.event.seq,
      text: result.text,
    }
  },
  update: context => context.state,
  buildViewNode: (context) => {
    const state = context.state
    return state === undefined
      ? null
      : viewNode(
          context,
          state.seq,
          `tool:${state.callId}`,
          FALLBACK_PRIORITY,
          'tool',
          `${state.callId} · ${state.error ? 'error' : 'done'}\n${state.text}`,
        )
  },
}

export const commandDefinition: ConversationNodeDefinition<CommandState> = {
  kind: 'tui-command',
  target: VIEW_TARGET,
  match: (event) => {
    if (event.type === 'command/run') return { id: String(event.data.commandId), role: 'start' }
    if (event.type === 'command/done') return { id: String(event.data.commandId), role: 'update' }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'command/run') throw new Error('tui command requires command/run')
    return {
      args: match.event.data.args ?? '',
      commandId: String(match.event.data.commandId),
      name: match.event.data.name,
      outcome: undefined,
    }
  },
  update: (context, match) => match.event.type === 'command/done'
    ? {
        ...context.state,
        outcome: `${match.event.data.kind}${match.event.data.text === undefined ? '' : ` · ${match.event.data.text}`}`,
      }
    : context.state,
  buildViewNode: (context) => {
    const state = context.state
    if (state === undefined) return null
    return viewNode(
      context,
      context.start?.event.seq ?? 0,
      `command:${state.commandId}`,
      MAIN_PRIORITY,
      'command',
      `/${state.name}${state.args} · ${state.outcome ?? 'running'}`,
    )
  },
}

export const commandFallbackDefinition: ConversationNodeDefinition<{
  readonly commandId: string
  readonly outcome: string
  readonly seq: number
}> = {
  kind: 'tui-command-done',
  target: VIEW_TARGET,
  match: event => event.type === 'command/done'
    ? { id: `${String(event.data.commandId)}:${event.seq}`, role: 'start' }
    : null,
  start: (_context, match) => {
    if (match.event.type !== 'command/done') throw new Error('tui command done requires command/done')
    return {
      commandId: String(match.event.data.commandId),
      outcome: `${match.event.data.kind}${match.event.data.text === undefined ? '' : ` · ${match.event.data.text}`}`,
      seq: match.event.seq,
    }
  },
  update: context => context.state,
  buildViewNode: context => context.state === undefined
    ? null
    : viewNode(
        context,
        context.state.seq,
        `command:${context.state.commandId}`,
        FALLBACK_PRIORITY,
        'command',
        `command ${context.state.commandId} · ${context.state.outcome}`,
      ),
}
