import type { Context } from '@deepseek-ai/cordis'

/**
 * The dynamic-plugin runner, which is what lets a session compose plugins at run
 * time — the machinery behind creator mode.
 *
 * Only the Web bundle ships this row, so a terminal profile has to mount it to
 * offer that mode at all. The plain dependency pins the runner to the supported
 * harness release; it does not guarantee a single copy in a consumer profile.
 */

export const name = 'tui-host-runner'

export async function apply(ctx: Context): Promise<void> {
  const { default: runner } = await import('@deepseek-ai/dsh-cordis-host-runner')
  ctx.plugin(runner)
}
