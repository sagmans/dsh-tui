import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  cardOfCall,
  cardOfResult,
  contentLines,
  type ToolPresenter,
  type ToolResultInput,
} from '../cards.ts'

function parseArguments(argumentsJson: string): unknown {
  try {
    return JSON.parse(argumentsJson) as unknown
  } catch {
    return undefined
  }
}

/**
 * The content a tool returned, unwrapped from the durable result envelope.
 *
 * A `presentResult` is handed the tool's own {@link ContentBlock}s. The durable
 * `tool/result` wraps them one level deeper, inside a `tool-result` block, so
 * passing the envelope through makes every presenter that inspects its content
 * decline — which is how a terminal result silently became a generic card.
 */
function toolResultContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as Record<string, unknown>
    if (record.type === 'tool-result' && Array.isArray(record.content)) return record.content
  }
  return content
}

/**
 * Present tool calls and results through each tool's own render intent.
 *
 * The surface must not know tool names: a tool package declares how its call
 * and result read. An unknown tool, a missing presenter, or a throwing one
 * degrades to the generic card instead of breaking the transcript, because a
 * broken card is recoverable and a broken transcript is not.
 *
 * The scope is the agent whose session is on screen, not the plugin's own
 * composition. An agent preset registers its tools in the agent's scoped world,
 * so a scope-less lookup sees none of them and every card degrades to a bare
 * generic row — which is how a bash card lost its command.
 */
export function createToolPresenter(ctx: Context, scope?: () => Agent | undefined): ToolPresenter {
  const definition = (name: string) => {
    try {
      return ctx.tools.get(name, scope?.())
    } catch {
      return undefined
    }
  }
  return {
    call(name, argumentsJson) {
      try {
        const view = definition(name)?.presentCall?.(parseArguments(argumentsJson) as never)
        // No definition, or a tool that declares no call view: leave the row to
        // the transcript's own fallback, which at least shows the raw arguments
        // the call was made with. `cardOfCall(undefined, ...)` would return a
        // generic card that silently drops them.
        return view === undefined ? undefined : cardOfCall(view, name)
      } catch {
        return undefined
      }
    },
    result(name, input: ToolResultInput) {
      try {
        const view = definition(name)?.presentResult?.(
          parseArguments(input.argumentsJson) as never,
          { content: toolResultContent(input.content), isError: input.isError, meta: input.meta } as never,
        )
        return cardOfResult(view, {
          fallbackTitle: name,
          failed: input.isError,
          contentLines: contentLines(input.content),
        })
      } catch {
        return undefined
      }
    },
  }
}
