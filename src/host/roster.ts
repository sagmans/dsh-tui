import type { Context } from '@deepseek-ai/cordis'
import { loadPresetDefinitions } from './preset-files.ts'

/**
 * The roster of agent modes, mounted for the supported harness line.
 *
 * This bundle owns the modes a terminal profile offers, and the line keeps them in
 * two places: a registry row owns the `agentPresets` service, and one row per mode
 * declares the mode itself. The patch layer cannot mount either of them: a patch
 * row is mounted before any service exists, and the modes arrive as the harness's
 * own agent services come up, so the surface that waits on the roster would be
 * built before it. Mounting from this row keeps the surface's check honest — the
 * composition either publishes the roster or reports which service never arrived.
 */

export const name = 'tui-host-roster'

/** Prefer program-mediated tool use for unnamed new sessions; picker order is independent. */
export const DEFAULT_PRESET = 'ptc'

/**
 * Wait until a roster is really published.
 *
 * The registry row provides its service from its own asynchronous apply, and the
 * surface is built as soon as the harness's agent services are up. Waiting here
 * rather than letting the surface tolerate a roster that is not up yet is what
 * keeps the surface's own capability check from mistaking a missing roster for a
 * host that never offered one.
 */
function whenRosterIsUp(ctx: Context): Promise<void> {
  return new Promise<void>((resolve) => {
    ctx.inject(['agentPresets'], () => resolve())
  })
}

export async function apply(ctx: Context): Promise<void> {
  const { default: registry } = await import('@deepseek-ai/dsh-agent-preset-registry')
  // Keep the fallback with the registry so its selected-default setting can
  // override it. Cordis validates this config before the registry initializes.
  ctx.plugin(registry, { default: DEFAULT_PRESET })
  const { default: preset } = await import('@deepseek-ai/dsh-agent-preset')
  // A mode registers itself inside its own row's apply: awaiting them here is what
  // makes this row mean "the roster this profile offers" rather than "the rows it
  // asked for", for every reader that comes after it.
  await Promise.all(loadPresetDefinitions().map(definition => ctx.plugin(preset, definition)))
  await whenRosterIsUp(ctx)
}
