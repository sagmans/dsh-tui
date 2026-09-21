// Disk layout for prompt stashes.
//
// A stash is scoped to the exact working directory: a linked worktree, a bare
// checkout, and a plain folder are all just distinct cwd values, so keying on
// cwd covers every case without any git discovery. The cwd is flattened into a
// filename-safe key by escaping separators and joining segments with "--", which
// stays human-readable in the agent directory while remaining injective. A deep
// path that overflows a filename keeps a readable prefix plus a hash of the full
// cwd, so two long paths never share a file.

import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'

/** The directory `DSH_HOME` points at when the environment names none. */
const DEFAULT_DSH_HOME_DIR = '.dsh'

/** The subtree of `DSH_HOME` this surface owns. */
const STASH_DIR_NAME = 'tui-stash'

// POSIX filenames may not contain "/" or NUL, and everything else is legal, so
// once separators are flattened the result is filename-safe on the platforms
// this surface targets. 200 keeps the on-disk name readable while staying well
// under the common 255-byte filename limit.
const SANITIZE_MAX_LENGTH = 200
const SEPARATOR = '--'
const KEY_FORMAT_VERSION = 'v1'
const KEY_PREFIX = `${KEY_FORMAT_VERSION}${SEPARATOR}`
const ESCAPE_CHARACTER = '%'
const ESCAPED_ESCAPE_CHARACTER = '%25'
const ESCAPED_SEPARATOR = '%2D%2D'
const BACKSLASH = '\\'
const ESCAPED_BACKSLASH = '%5C'
const HASH_ALGORITHM = 'sha256'
const HASH_LENGTH = 16

/** The stash file for one working directory. */
export interface StashPaths {
  /** Flattened cwd, used as the on-disk key. */
  readonly key: string
  /** JSON file holding this directory's stash entries. */
  readonly file: string
}

/** Escape one path segment so it cannot collide with the separator or an escape. */
function escapeSegment(segment: string): string {
  return segment
    .replaceAll(ESCAPE_CHARACTER, ESCAPED_ESCAPE_CHARACTER)
    .replaceAll(BACKSLASH, ESCAPED_BACKSLASH)
    .replaceAll(SEPARATOR, ESCAPED_SEPARATOR)
}

/** Keep whole characters while fitting a byte budget, so a cut cannot split one. */
function truncateToUtf8Bytes(value: string, maxBytes: number): string {
  let bytes = 0
  let result = ''
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character)
    if (bytes + characterBytes > maxBytes) break
    result += character
    bytes += characterBytes
  }
  return result
}

export function sanitizeCwd(cwd: string): string {
  const segments = cwd.split('/').filter(Boolean).map(escapeSegment)
  const sanitized = `${KEY_PREFIX}${segments.join(SEPARATOR)}`
  if (Buffer.byteLength(sanitized) <= SANITIZE_MAX_LENGTH) return sanitized

  // An unusually deep cwd can overflow a filename. Keep the readable prefix and
  // append a stable hash of the full cwd so two distinct long paths never
  // collide while remaining identifiable.
  const digest = createHash(HASH_ALGORITHM).update(cwd, 'utf8').digest('hex').slice(0, HASH_LENGTH)
  const suffix = `${SEPARATOR}${digest}`
  const prefix = truncateToUtf8Bytes(sanitized, SANITIZE_MAX_LENGTH - Buffer.byteLength(suffix))
  return `${prefix}${suffix}`
}

/**
 * The directory the harness keeps its own state in.
 *
 * DSH_HOME is the one thing that moves that directory, and it is resolved the
 * same way the settings document resolves it, so a scratch home keeps stash data
 * out of a reader's real home during a test run.
 */
export function dshHomeDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const configured = env.DSH_HOME?.trim()
  return configured === undefined || configured === '' ? path.join(home, DEFAULT_DSH_HOME_DIR) : configured
}

/** The root every working directory's stash file sits under. */
export function stashBaseDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return path.join(dshHomeDir(env, home), STASH_DIR_NAME)
}

export function resolveStashPaths(cwd: string, baseDir: string = stashBaseDir()): StashPaths {
  const key = sanitizeCwd(cwd)
  return { key, file: path.join(baseDir, `${key}.json`) }
}
