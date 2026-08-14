import type { Context } from '@deepseek-ai/cordis'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-runtime/client'
import {
  assistantDefinition,
  assistantFallbackDefinition,
  messageDefinition,
} from './conversation/messages.js'
import {
  compactionDefinition,
  requestContextDefinition,
  requestHeaderDefinition,
  retryDefinition,
  todoDefinition,
  turnEndDefinition,
} from './conversation/state.js'
import {
  tuiConversationViewDefinition,
  unknownFallbackDefinition,
} from './conversation/shared.js'
import {
  commandDefinition,
  commandFallbackDefinition,
} from './conversation/commands.js'
import {
  toolDefinition,
  toolFallbackDefinition,
} from './conversation/tools.js'

export { tuiConversationViewDefinition } from './conversation/shared.js'

export const TUI_CONVERSATION_DEFINITIONS: readonly ConversationNodeDefinition[] = Object.freeze([
  messageDefinition,
  assistantDefinition,
  assistantFallbackDefinition,
  toolDefinition,
  toolFallbackDefinition,
  commandDefinition,
  commandFallbackDefinition,
  compactionDefinition,
  retryDefinition,
  turnEndDefinition,
  todoDefinition,
  requestHeaderDefinition,
  requestContextDefinition,
])

export function registerTuiConversationRuntime(ctx: Context): void {
  ctx.conversationViews.register(tuiConversationViewDefinition)
  for (const definition of TUI_CONVERSATION_DEFINITIONS) ctx.conversationEvents.register(definition)
  ctx.conversationEvents.registerFallback(unknownFallbackDefinition)
}
