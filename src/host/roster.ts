import type { Context } from '@deepseek-ai/cordis'
import { runsOnNewLine } from './generation.ts'
import { loadPresetDefinitions } from './preset-files.ts'

/**
 * The roster of agent modes, mounted for whichever harness line is running.
 *
 * This bundle owns the modes a terminal profile offers, and the two lines keep
 * them in different places: 0.1.5 has one roster package that discovers its own
 * modes, while 0.1.7 dissolved it into a registry row plus one row per mode. The
 * patch layer cannot choose between them — a row that waits for a service is
 * mounted after the surface that needs the roster — so the choice is made here,
 * from the composed tree, which exists before either line loads a service.
 */

export const name = 'tui-host-roster'

/** The part of a plugin's schema a row config is resolved through. */
interface SchemaLike {
  readonly '~standard'?: {
    readonly validate?: (input: unknown) => { readonly value?: unknown } | undefined
  }
}

/**
 * Mount a host row with the config a patch row would carry.
 *
 * A row config holds only what a profile overrode, while a plugin's `Config` is
 * what its own schema produces once the rest is filled in — the loader validates
 * through that schema before it mounts a row, and this bundle mounting a package
 * directly has to do the same. The retired roster is where it matters: mounted
 * with a partial config it never publishes the service the surface waits for.
 */
function mountRow(ctx: Context, plugin: unknown, config: Record<string, unknown>): void {
  const schema = (plugin as { readonly Config?: SchemaLike })?.Config
  const resolved: unknown = schema?.['~standard']?.validate?.(config)?.value ?? config
  ;(ctx.plugin as unknown as (plugin: unknown, config: unknown) => void)(plugin, resolved)
}

/** The mode a session runs when nobody names one, as the shipped modes order them. */
export const DEFAULT_PRESET = 'ptc'

/**
 * Wait until a roster is really published.
 *
 * Each line's roster package provides its service from its own asynchronous
 * apply, and the surface is built as soon as the harness's agent services are up.
 * Waiting here — rather than letting the surface tolerate a roster that is not up
 * yet — keeps the surface's own capability check honest on both lines: it either
 * finds the roster, or the composition reports which service never arrived.
 */
function whenRosterIsUp(ctx: Context): Promise<void> {
  return new Promise<void>((resolve) => {
    ctx.inject(['agentPresets'], () => resolve())
  })
}

export async function apply(ctx: Context): Promise<void> {
  if (!runsOnNewLine(ctx)) {
    const { default: roster } = await import('@deepseek-ai/dsh-agent-presets')
    // The retired roster discovers modes on disk and takes the fallback as config.
    mountRow(ctx, roster, { default: DEFAULT_PRESET })
    await whenRosterIsUp(ctx)
    return
  }
  const { default: registry } = await import('@deepseek-ai/dsh-agent-preset-registry')
  // The registry takes the fallback mode as its own config field and publishes its
  // service without the schema step the retired roster needs.
  ctx.plugin(registry, { default: DEFAULT_PRESET })
  const { default: preset } = await import('@deepseek-ai/dsh-agent-preset')
  for (const definition of loadPresetDefinitions()) ctx.plugin(preset, definition)
  await whenRosterIsUp(ctx)
}
