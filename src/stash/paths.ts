// Disk layout for prompt stashes.
//
// A bank follows either the absolute working directory or one session. The
// distinct key versions prevent an absolute directory from ever colliding with
// a session id, while both identifiers stay readable under the stash directory.
//
// Readability cannot be bought with injectivity: a separator made of hyphens
// cannot be told apart from a hyphen inside an owner id, and truncating a long
// id can land on a name a shorter id already owns. Two distinct owners sharing
// one bank would expose drafts, so every key ends with a digest of the exact id. The readable part is then only a label: two distinct
// identifiers collide in the label, never in the file.

import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'

/** The directory `DSH_HOME` points at when the environment names none. */
const DEFAULT_DSH_HOME_DIR = '.dsh'

/** A bank follows the current directory by default; session mode keeps drafts private to one session. */
export const DEFAULT_STASH_SCOPE = 'path' as const
export const STASH_SCOPES = [DEFAULT_STASH_SCOPE, 'session'] as const
export type StashScope = typeof STASH_SCOPES[number]

/** The subtree of `DSH_HOME` this surface owns. */
const STASH_DIR_NAME = 'tui-stash'

// POSIX filenames may not contain "/" or NUL, and everything else is legal, so
// once separators are flattened the result is filename-safe on the platforms
// this surface targets. 200 keeps the whole key, digest included, well under the
// common 255-byte filename limit.
const SANITIZE_MAX_LENGTH = 200
const SEPARATOR = '--'
const SESSION_KEY_FORMAT_VERSION = 'v2'
const PATH_KEY_FORMAT_VERSION = 'v3'
const ESCAPE_CHARACTER = '%'
const ESCAPED_ESCAPE_CHARACTER = '%25'
const ESCAPED_SEPARATOR = '%2D%2D'
const BACKSLASH = '\\'
const ESCAPED_BACKSLASH = '%5C'
const HASH_ALGORITHM = 'sha256'
/** 64 bits of digest, which no deliberate name can be built to collide with. */
const HASH_LENGTH = 16

/** The stash file for one scope owner. */
export interface StashPaths {
  /** Exact scope owner, retained in the on-disk sessionId field. */
  readonly sessionId: string
  /** Flattened owner id, used as the on-disk key. */
  readonly key: string
  /** JSON file holding this bank's stash entries. */
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

export function sanitizeSessionId(sessionId: string, version: string = SESSION_KEY_FORMAT_VERSION): string {
  const keyPrefix = `${version}${SEPARATOR}`
  const readable = sessionId.split('/').filter(Boolean).map(escapeSegment).join(SEPARATOR)
  const digest = createHash(HASH_ALGORITHM).update(sessionId, 'utf8').digest('hex').slice(0, HASH_LENGTH)
  const suffix = `${SEPARATOR}${digest}`
  const budget = SANITIZE_MAX_LENGTH - Buffer.byteLength(keyPrefix) - Buffer.byteLength(suffix)
  return `${keyPrefix}${truncateToUtf8Bytes(readable, Math.max(budget, 0))}${suffix}`
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

/** The root every bank's stash file sits under. */
export function stashBaseDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return path.join(dshHomeDir(env, home), STASH_DIR_NAME)
}

export function resolveStashPaths(sessionId: string, baseDir: string = stashBaseDir(), scope: StashScope = 'session'): StashPaths {
  const key = sanitizeSessionId(sessionId, scope === 'path' ? PATH_KEY_FORMAT_VERSION : SESSION_KEY_FORMAT_VERSION)
  return { sessionId, key, file: path.join(baseDir, `${key}.json`) }
}
