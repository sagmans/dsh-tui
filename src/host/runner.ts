import type { Context } from '@deepseek-ai/cordis'
import { harnessLine } from './generation.ts'

/**
 * The dynamic-plugin runner, which is what lets a session compose plugins at run
 * time — the machinery behind creator mode.
 *
 * Each release line rebuilt the runner's protocol, so a copy built for one line
 * cannot serve another, and the runner is also what reports the hosting runtime
 * version to every row it mounts. Serving the newest line with an older build
 * therefore does not degrade gracefully: the harness reads the older version off
 * it and disables that host's own rows as incompatible. The profile installs one
 * aliased copy per line, and which one mounts is decided from the hosting release
 * for the same reason the roster is — the surface mounts as soon as its own
 * services are up, which is before any line's settings are published.
 *
 * Every line is served from an alias, including the oldest: a plain dependency on
 * this package would resolve to the oldest release a profile can satisfy, and the
 * base's own runner row loads whatever the profile installed under that name, so
 * a range here is what made a 0.2.0 host announce itself as 0.1.7.
 */

export const name = 'tui-host-runner'

/** The aliased build that speaks each line's protocol. */
export const RUNNER_BY_LINE: Readonly<Record<'0.1.5' | '0.1.7' | '0.2.0', string>> = {
  '0.1.5': '@sagmans/dsh-cordis-host-runner-015',
  '0.1.7': '@sagmans/dsh-cordis-host-runner-017',
  '0.2.0': '@sagmans/dsh-cordis-host-runner-020',
}

export async function apply(ctx: Context): Promise<void> {
  const { default: runner } = await import(RUNNER_BY_LINE[harnessLine(ctx)])
  ctx.plugin(runner)
}
