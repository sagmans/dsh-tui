import type { Context } from '@deepseek-ai/cordis'

/**
 * The dynamic-plugin runner, which is what lets a session compose plugins at run
 * time — the machinery behind creator mode.
 *
 * Only the Web bundle ships this row, so a terminal profile has to mount it to
 * offer that mode at all. The dependency is plain rather than an alias of its own
 * line: the runner is what reports the hosting runtime version to every row it
 * mounts, so a second copy of the package in a profile — which a per-line alias
 * exists to create — is what makes a host read itself as another release and
 * disable its own rows as incompatible.
 */

export const name = 'tui-host-runner'

export async function apply(ctx: Context): Promise<void> {
  const { default: runner } = await import('@deepseek-ai/dsh-cordis-host-runner')
  ctx.plugin(runner)
}
