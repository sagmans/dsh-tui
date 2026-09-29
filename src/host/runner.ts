import type { Context } from '@deepseek-ai/cordis'
import { runsOnNewLine } from './generation.ts'

/**
 * The dynamic-plugin runner, which is what lets a session compose plugins at run
 * time — the machinery behind creator mode.
 *
 * The 0.1.7 release rebuilt the runner's protocol, so a copy built for one line
 * cannot serve the other: the profile installs both, and the aliased one is the
 * name that resolves the newer build. Which copy mounts is decided from the
 * composed tree for the same reason the roster is — the surface mounts as soon as
 * its own services are up, which is before any line's settings are published.
 */

export const name = 'tui-host-runner'

export async function apply(ctx: Context): Promise<void> {
  if (runsOnNewLine(ctx)) {
    const { default: runner } = await import('@sagmans/dsh-cordis-host-runner-017')
    ctx.plugin(runner)
    return
  }
  const { default: runner } = await import('@deepseek-ai/dsh-cordis-host-runner')
  ctx.plugin(runner)
}
