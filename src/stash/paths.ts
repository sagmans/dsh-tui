// Disk layout for prompt stashes.
//
// A bank follows either the absolute working directory or one session. The
// distinct key versions prevent an absolute directory from ever colliding with
// a session id, while both identifiers stay readable under the stash directory.
//
// Flattening and truncation can give distinct owners the same readable label.
// A digest of the exact owner reduces those collisions; it does not rule them out.
// The store also checks the persisted owner before accepting a bank, so a filename
// match alone cannot expose another owner's drafts.

import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'

/** Environment variable that moves the harness home, matching the launcher. */
const DSH_HOME_ENV = 'DSH_HOME'

/** The directory `DSH_HOME` points at when the environment names none. */
const DEFAULT_DSH_HOME_DIR = '.dsh'

/** A bank follows the current directory by default; session mode keeps drafts private to one session. */
export const DEFAULT_STASH_SCOPE = 'path' as const
export const STASH_SCOPES = [DEFAULT_STASH_SCOPE, 'session'] as const
export type StashScope = typeof STASH_SCOPES[number]

/** The character a hand-written `DSH_HOME` leads with when it names the OS home. */
const HOME_TILDE = '~'

/** What may follow that character and still mean a home directory, on either platform. */
const HOME_TILDE_SEPARATORS = ['/', '\\'] as const

/** The subtree of `DSH_HOME` this surface owns. */
const STASH_DIR_NAME = 'tui-stash'

// Owner path separators must not create nested banks. Flattening and escaping
// address those separators, not every filename constraint: NUL is left unchanged.
// The 200-byte key budget, digest included, leaves room for the .json extension
// under the common 255-byte filename limit.
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
/** Retain a 64-bit owner digest to distinguish labels within the filename budget, not to guarantee uniqueness. */
const HASH_LENGTH = 16

/** Keep the exact owner beside its filename key so the store can reject a bank with a mismatched persisted owner. */
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

function sanitizeSessionId(sessionId: string, version: string): string {
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
 * DSH_HOME is the one thing that moves that directory, so every reader resolves it
 * here: the stash bank, the themes, and the prompt history all write under the
 * answer, and a scratch home only keeps state out of a reader's real home while
 * they agree on it. A blank override is treated as unset, because resolving to the
 * working directory would scatter private state into whatever tree the reader
 * happened to start from.
 */
export function dshHomeDir(): string {
  const home = homedir()
  const configured = process.env[DSH_HOME_ENV]?.trim()
  if (configured === undefined || configured === '') return path.join(home, DEFAULT_DSH_HOME_DIR)
  return expandHome(configured, home)
}

/**
 * Expand a hand-written leading `~` into the caller's home.
 *
 * The value arrives from the environment rather than from a shell, so nothing has
 * expanded it yet. `~user` and an interior `~` are ordinary path text everywhere
 * but a shell, and rewriting them would move a directory the reader named exactly;
 * with no home to expand into the value stays as written, because joining a blank
 * home would land the state in the process's working directory by accident.
 */
function expandHome(value: string, home: string): string {
  if (home === '') return value
  if (value === HOME_TILDE) return home
  const separator = HOME_TILDE_SEPARATORS.find(candidate => value.startsWith(HOME_TILDE + candidate))
  return separator === undefined ? value : path.join(home, value.slice(HOME_TILDE.length + separator.length))
}

/** The root every bank's stash file sits under. */
export function stashBaseDir(): string {
  return path.join(dshHomeDir(), STASH_DIR_NAME)
}

/**
 * Separate scope namespaces leave drafts in their original banks when the surface changes scope.
 * PromptStash supplies its configured scope so bank ownership stays with the surface.
 */
export function resolveStashPaths(sessionId: string, baseDir: string, scope: StashScope): StashPaths {
  const key = sanitizeSessionId(sessionId, scope === 'path' ? PATH_KEY_FORMAT_VERSION : SESSION_KEY_FORMAT_VERSION)
  return { sessionId, key, file: path.join(baseDir, `${key}.json`) }
}
