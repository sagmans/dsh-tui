import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { RUN_CODE_NAME, type ToolCallView } from '@deepseek-ai/dsh-tools'
import { cardOfCall, cardOfResult } from '../cards/presenter.ts'
import { contentLines, type ToolPresenter, type ToolResultInput } from '../cards.ts'

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
 * The reserved PTC transport's call view, synthesized from recorded arguments.
 *
 * Since harness 0.2.2 the `run_code` definition lives inside the mounted tool
 * executor and the registry refuses to resolve it, so the scoped lookup misses
 * on exactly the calls PTC mode shows the reader. The presentation contract is
 * unchanged and client-safe: the model-authored description is the card's
 * always-visible label and the program rides rawInput, the same facts the
 * harness's own trajectory client reads from the log. Invalid arguments leave
 * the row to the transcript's raw-argument fallback rather than guessing.
 */
function runCodeCallView(name: string, args: unknown): ToolCallView | undefined {
  if (name !== RUN_CODE_NAME) return undefined
  if (typeof args !== 'object' || args === null) return undefined
  const { code, description } = args as { code?: unknown; description?: unknown }
  if (typeof code !== 'string' || typeof description !== 'string') return undefined
  return { card: 'generic', title: description, kind: 'execute', rawInput: code }
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
export function createToolPresenter(ctx: Context, scope: () => Agent | undefined): ToolPresenter {
  const definition = (name: string) => {
    try {
      return ctx.tools.get(name, scope())
    } catch {
      return undefined
    }
  }
  return {
    call(name, argumentsJson) {
      try {
        const args = parseArguments(argumentsJson)
        const view = definition(name)?.presentCall?.(args as never) ?? runCodeCallView(name, args)
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
          {
            content: toolResultContent(input.content),
            isError: input.isError,
            meta: input.meta,
          } as never,
        )
        return cardOfResult(view, {
          name,
          failed: input.isError,
          contentLines: contentLines(input.content),
        })
      } catch {
        return undefined
      }
    },
  }
}
