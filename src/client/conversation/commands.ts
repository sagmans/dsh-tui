import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-runtime/client'
import {
  FALLBACK_PRIORITY,
  MAIN_PRIORITY,
  VIEW_TARGET,
  viewNode,
} from './shared.js'

interface CommandState {
  readonly args: string
  readonly commandId: string
  readonly name: string
  readonly outcome: string | undefined
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
