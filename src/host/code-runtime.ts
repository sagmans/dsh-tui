import type { Context } from '@deepseek-ai/cordis'
import { runsOnNewLine } from './generation.ts'

/**
 * The code runtime PTC mode runs programs against.
 *
 * Only the 0.1.5 line needs it mounted here: 0.1.7 moved the runtime into the
 * base as a row of its own, and mounting the older worker-thread runtime beside
 * it would register a second runtime for the same service. Following the line
 * here rather than in the patch is what the composed tree is read for.
 */

export const name = 'tui-host-code-runtime'

export async function apply(ctx: Context): Promise<void> {
  if (runsOnNewLine(ctx)) return
  const { default: runtime } = await import('@deepseek-ai/dsh-code-runtime-worker-thread')
  ctx.plugin(runtime)
}
