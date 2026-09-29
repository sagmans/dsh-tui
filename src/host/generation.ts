import type { Context } from '@deepseek-ai/cordis'

/**
 * Which harness line is hosting this process.
 *
 * A patch row mounts before any service exists, so no service can answer this —
 * and a row that waits for one applies after the surface that needs the roster
 * has already been built, because the surface's own dependencies come up earlier.
 * The composed base is the one signal present at that moment, and the lines differ
 * in it: 0.1.7 moved the PTC runtime into the base as a row of its own, while
 * 0.1.5 has no such row at all — which is why this bundle mounts a runtime itself
 * on that line. Row ids are namespaced by the profile that includes them, so only
 * the last segment of an id is matched.
 */

/** The base row only the 0.1.7 line composes. */
const NEW_LINE_BASE_ROW = 'ptc-runtime'

/** The part of the loader this probe needs: the composed tree, walked by id. */
interface ComposedTree {
  entries?: () => Iterable<{ readonly id: unknown }>
}

/**
 * Answer from the composed tree, and answer 0.1.5 when it cannot be read.
 *
 * Nothing else is available this early, and guessing the newer line would mount
 * machinery that line already has — the older answer at worst mounts what the
 * newer line has retired, which is the same choice a profile patch can override.
 */
export function runsOnNewLine(ctx: Context): boolean {
  const tree = (ctx as { readonly loader?: ComposedTree }).loader
  try {
    for (const entry of tree?.entries?.() ?? []) {
      if (String(entry.id).split(':').pop() === NEW_LINE_BASE_ROW) return true
    }
  } catch {
    // A tree that cannot be walked is a harness this bundle cannot serve either
    // way, so the answer only has to be one the composition can act on.
  }
  return false
}
