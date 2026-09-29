import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

/**
 * Which harness line is hosting this process.
 *
 * A patch row mounts before any service exists, so no service can answer this —
 * and a row that waits for one applies after the surface that needs the roster
 * has already been built, because the surface's own dependencies come up earlier.
 * Two signals survive that moment: the hosting base release, which a profile
 * installs beside this package, and the composed tree, which is walked when the
 * release cannot be read.
 *
 * The line decides three rows. 0.1.5 composes no PTC runtime row and publishes no
 * preset registry; 0.1.7 and 0.2.0 do both, and each newer release speaks a runner
 * protocol the older runner cannot serve. The runner is what reports the runtime
 * version, so mounting the wrong one makes every row of that line look
 * incompatible with the host and the harness disables them one by one.
 */

/** A line this bundle ships a build for. */
export type HarnessLine = '0.1.5' | '0.1.7' | '0.2.0'

/** Releases whose own numbers name the line. */
const LINE_BY_BASE_RELEASE: Readonly<Record<string, HarnessLine>> = {
  '0.1.5': '0.1.5',
  '0.1.7': '0.1.7',
  '0.2.0': '0.2.0',
}

/** The newest line this bundle knows; a later release mounts this build. */
const NEWEST_LINE: HarnessLine = '0.2.0'

/** The oldest line, and the answer when nothing can be read. */
const OLDEST_LINE: HarnessLine = '0.1.5'

/** The base row the lines from 0.1.7 on compose and 0.1.5 does not. */
const NEW_LINE_BASE_ROW = 'ptc-runtime'

/** The package a hosting profile installs beside this one. */
const BASE_PACKAGE = '@deepseek-ai/dsh-base'

/** The part of the loader the tree fallback needs: entries, walked by id. */
interface ComposedTree {
  entries?: () => Iterable<{ readonly id: unknown }>
}

/** A release's numbers without the prerelease tag, which is what a line names. */
function releaseNumbers(version: string): number[] {
  const [numbers] = version.split('-')
  return (numbers ?? '').split('.').map(Number)
}

/**
 * Answer for a base release.
 *
 * A release past the newest one named above still mounts the newest build: the
 * newest base row is what that build is written against, and refusing to answer
 * would mount machinery the host has already replaced.
 */
export function lineForRelease(version: string): HarnessLine | undefined {
  const named = LINE_BY_BASE_RELEASE[releaseNumbers(version).join('.')]
  if (named !== undefined) return named
  const numbers = releaseNumbers(version)
  const newest = releaseNumbers(NEWEST_LINE)
  if (numbers.length < newest.length || numbers.some(Number.isNaN)) return undefined
  for (const [index, bound] of newest.entries()) {
    const actual = numbers[index]
    if (actual === undefined) return undefined
    if (actual === bound) continue
    return actual > bound ? NEWEST_LINE : undefined
  }
  return NEWEST_LINE
}

/** How far up from a resolved entry a manifest can sit before this gives up. */
const MANIFEST_SEARCH_DEPTH = 4

/**
 * Read the hosting base's manifest.
 *
 * The package does not export its own `package.json`, so the version is read by
 * resolving the entry point and walking up to the manifest that names the package.
 */
function readBaseManifest(): { readonly version?: unknown } | undefined {
  let directory: string
  try {
    directory = dirname(createRequire(import.meta.url).resolve(BASE_PACKAGE))
  } catch {
    // A profile that installs no base beside this bundle leaves the tree to speak.
    return undefined
  }
  for (let depth = 0; depth < MANIFEST_SEARCH_DEPTH; depth += 1) {
    const candidate = join(directory, 'package.json')
    try {
      const manifest = JSON.parse(readFileSync(candidate, 'utf8')) as {
        readonly name?: unknown
        readonly version?: unknown
      }
      if (manifest.name === BASE_PACKAGE) return manifest
    } catch {
      // No manifest here is the ordinary case on the way up, not a failure.
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return undefined
}

/** The line the installed base release names, when it can be read at all. */
function lineFromBaseRelease(): HarnessLine | undefined {
  const manifest = readBaseManifest()
  return typeof manifest?.version === 'string' ? lineForRelease(manifest.version) : undefined
}

/** The line the composed tree names, by the row only the newer lines carry. */
function lineFromComposedTree(ctx: Context): HarnessLine {
  const tree = (ctx as { readonly loader?: ComposedTree }).loader
  try {
    for (const entry of tree?.entries?.() ?? []) {
      if (String(entry.id).split(':').pop() === NEW_LINE_BASE_ROW) return '0.1.7'
    }
  } catch {
    // A tree that cannot be walked leaves the oldest answer, which mounts what
    // the newer lines retired rather than machinery they already have.
  }
  return OLDEST_LINE
}

/** Which harness line is hosting this process. */
export function harnessLine(ctx: Context): HarnessLine {
  return lineFromBaseRelease() ?? lineFromComposedTree(ctx)
}
