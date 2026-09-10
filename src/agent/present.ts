import type { Context } from '@deepseek-ai/cordis'
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
 * Present tool calls and results through each tool's own render intent.
 *
 * The surface must not know tool names: a tool package declares how its call
 * and result read. An unknown tool, a missing presenter, or a throwing one
 * degrades to the generic card instead of breaking the transcript, because a
 * broken card is recoverable and a broken transcript is not.
 */
export function createToolPresenter(ctx: Context): ToolPresenter {
  const definition = (name: string) => {
    try {
      return ctx.tools.get(name)
    } catch {
      return undefined
    }
  }
  return {
    call(name, argumentsJson) {
      try {
        const view = definition(name)?.presentCall?.(parseArguments(argumentsJson) as never)
        return cardOfCall(view, name)
      } catch {
        return undefined
      }
    },
    result(name, input: ToolResultInput) {
      try {
        const view = definition(name)?.presentResult?.(
          parseArguments(input.argumentsJson) as never,
          { content: input.content, isError: input.isError, meta: input.meta } as never,
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
