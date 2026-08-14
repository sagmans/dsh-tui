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
import { workflowDefinition } from './conversation/workflows.js'
import { registerTuiTrajectoryRuntime } from './trajectory.js'
import { deliverablesDefinition } from './conversation/deliverables.js'

export { tuiConversationViewDefinition } from './conversation/shared.js'

export const TUI_CONVERSATION_DEFINITIONS: readonly ConversationNodeDefinition[] = Object.freeze([
  messageDefinition,
  assistantDefinition,
  assistantFallbackDefinition,
  toolDefinition,
  toolFallbackDefinition,
  commandDefinition,
  commandFallbackDefinition,
  workflowDefinition,
  compactionDefinition,
  retryDefinition,
  turnEndDefinition,
  todoDefinition,
  requestHeaderDefinition,
  requestContextDefinition,
  deliverablesDefinition,
])

export function registerTuiConversationRuntime(ctx: Context): void {
  ctx.conversationViews.register(tuiConversationViewDefinition)
  registerTuiTrajectoryRuntime(ctx)
  for (const definition of TUI_CONVERSATION_DEFINITIONS) ctx.conversationEvents.register(definition)
  ctx.conversationEvents.registerFallback(unknownFallbackDefinition)
}
