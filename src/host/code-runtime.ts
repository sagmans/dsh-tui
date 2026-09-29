import type { Context } from '@deepseek-ai/cordis'
import { harnessLine } from './generation.ts'

/**
 * The code runtime PTC mode runs programs against.
 *
 * Only the 0.1.5 line needs it mounted here: the lines from 0.1.7 on moved the
 * runtime into the base as a row of their own, and mounting the older
 * worker-thread runtime beside it would register a second runtime for the same
 * service. Following the line here rather than in the patch is what the hosting
 * release is read for.
 */

export const name = 'tui-host-code-runtime'

/** The oldest line's runtime, aliased so no plain name pins an older tree. */
const WORKER_THREAD_RUNTIME = '@sagmans/dsh-code-runtime-worker-thread-015'

export async function apply(ctx: Context): Promise<void> {
  if (harnessLine(ctx) !== '0.1.5') return
  const { default: runtime } = await import(WORKER_THREAD_RUNTIME)
  ctx.plugin(runtime)
}
