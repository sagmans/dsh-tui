// Disk layout for prompt stashes.
//
// A bank is scoped to one session: two terminals working in the same directory
// keep separate drafts, and a resumed session finds the drafts it parked before
// the restart, because the session id is what a resume preserves. The id is
// flattened into a filename-safe key that stays human-readable in the agent
// directory.
//
// Readability cannot be bought with injectivity: a separator made of hyphens
// cannot be told apart from a hyphen inside a session id, and truncating a long
// id can land on a name a shorter id already owns. Two sessions sharing one bank
// would let one read or delete another's drafts, so every key ends with a digest
// of the exact session id. The readable part is then only a label: two distinct
// ids collide in the label, never in the file.

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
const KEY_FORMAT_VERSION = 'v2'
const KEY_PREFIX = `${KEY_FORMAT_VERSION}${SEPARATOR}`
const ESCAPE_CHARACTER = '%'
const ESCAPED_ESCAPE_CHARACTER = '%25'
const ESCAPED_SEPARATOR = '%2D%2D'
const BACKSLASH = '\\'
const ESCAPED_BACKSLASH = '%5C'
const HASH_ALGORITHM = 'sha256'
/** 64 bits of digest, which no deliberate name can be built to collide with. */
const HASH_LENGTH = 16

/** The stash file for one session. */
export interface StashPaths {
  /** The exact session this bank belongs to. */
  readonly sessionId: string
  /** Flattened session id, used as the on-disk key. */
  readonly key: string
  /** JSON file holding this session's stash entries. */
  readonly file: string
}

/** Escape one key segment so it cannot collide with the separator or an escape. */
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

export function sanitizeSessionId(sessionId: string): string {
  const readable = sessionId.split('/').filter(Boolean).map(escapeSegment).join(SEPARATOR)
  const digest = createHash(HASH_ALGORITHM).update(sessionId, 'utf8').digest('hex').slice(0, HASH_LENGTH)
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

/** The root every session's stash file sits under. */
export function stashBaseDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return path.join(dshHomeDir(env, home), STASH_DIR_NAME)
}

export function resolveStashPaths(sessionId: string, baseDir: string = stashBaseDir()): StashPaths {
  const key = sanitizeSessionId(sessionId)
  return { sessionId, key, file: path.join(baseDir, `${key}.json`) }
}
