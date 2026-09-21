// Disk layout for prompt stashes.
//
// A stash is scoped to the exact working directory: a linked worktree, a bare
// checkout, and a plain folder are all just distinct cwd values, so keying on
// cwd covers every case without any git discovery. The cwd is flattened into a
// filename-safe key that stays human-readable in the agent directory.
//
// Readability cannot be bought with injectivity: a separator made of hyphens
// cannot be told apart from a hyphen inside a directory name, and truncating a
// deep path can land on a name a shorter path already owns. Two working
// directories sharing one bank would let one directory read or delete another's
// drafts, so every key ends with a digest of the exact cwd. The readable part is
// then only a label: two distinct cwds collide in the label, never in the file.

import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'

/** The directory `DSH_HOME` points at when the environment names none. */
const DEFAULT_DSH_HOME_DIR = '.dsh'

/** The subtree of `DSH_HOME` this surface owns. */
const STASH_DIR_NAME = 'tui-stash'

// POSIX filenames may not contain "/" or NUL, and everything else is legal, so
// once separators are flattened the result is filename-safe on the platforms
// this surface targets. 200 keeps the whole key, digest included, well under the
// common 255-byte filename limit.
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
/** 64 bits of digest, which no deliberate name can be built to collide with. */
const HASH_LENGTH = 16

/** The stash file for one working directory. */
export interface StashPaths {
  /** The exact working directory this bank belongs to. */
  readonly cwd: string
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
  const readable = cwd.split('/').filter(Boolean).map(escapeSegment).join(SEPARATOR)
  const digest = createHash(HASH_ALGORITHM).update(cwd, 'utf8').digest('hex').slice(0, HASH_LENGTH)
  const suffix = `${SEPARATOR}${digest}`
  const budget = SANITIZE_MAX_LENGTH - Buffer.byteLength(KEY_PREFIX) - Buffer.byteLength(suffix)
  return `${KEY_PREFIX}${truncateToUtf8Bytes(readable, Math.max(budget, 0))}${suffix}`
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
  return { cwd, key, file: path.join(baseDir, `${key}.json`) }
}
