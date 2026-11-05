/**
 * Real session and agent events prove which failure text reaches the screen and which reaches an
 * export, with no model route and so no billing.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SESSION_EVENT = 'session/event'
const TITLE_EVENT = 'session/title'
const AGENT_ERROR_EVENT = 'agent/error'
const REQUEST_TITLE = 'failure-notices-request'
const REASON = 'dogfood-failure-reason'
const TURN = 1
const STEP = 1
const THROW_COMMAND = 'failure-throw'
const REFUSE_COMMAND = 'failure-refuse'
const LOCK_COMMAND = 'failure-lock'
const LOCK_DONE = 'stale lock placed'
const LOCK_FILES = ['prompt-history.json.lock', 'prompt-history.json.lock.reclaim']
// Above any process id a system hands out, so the store always judges the holder stopped.
const STOPPED_OWNER = JSON.stringify({ pid: 2147483646, token: 'dogfood-stopped-session' })
const PRIVATE_FILE_MODE = 0o600
export const name = 'dogfood-failure-notices'
export const inject = ['sessions', 'commands']

/** The runner mounts this fixture only in its own credential-free home and triggers it with a local rename. */
export function apply(ctx) {
  // Both ways a plugin command can fail: the surface words them alike, so an export must treat them alike.
  ctx.commands.register({
    name: THROW_COMMAND,
    description: 'Throw a failure that names a fake value',
    handler: () => {
      throw new Error(REASON)
    },
  })
  ctx.commands.register({
    name: REFUSE_COMMAND,
    description: 'Refuse with a failure that names a fake value',
    handler: () => ({ kind: 'error', text: REASON }),
  })
  // A stale lock is a real store fault, and the store quotes its path, so both history notices fail for real.
  ctx.commands.register({
    name: LOCK_COMMAND,
    description: 'Leave the prompt history behind a lock that names a stopped session',
    handler: () => {
      for (const name of LOCK_FILES) {
        writeFileSync(join(process.env.DSH_HOME, name), STOPPED_OWNER, { mode: PRIVATE_FILE_MODE })
      }
      return { kind: 'success', text: LOCK_DONE }
    },
  })
  let requested = false
  ctx.on(SESSION_EVENT, (session, event) => {
    if (requested || event.type !== TITLE_EVENT || event.data.title !== REQUEST_TITLE) return
    requested = true
    // Publish after this event settles, because an append inside a publication would reorder the log.
    queueMicrotask(() => {
      ctx.emit(AGENT_ERROR_EVENT, {
        agent: { id: session.id },
        turn: TURN,
        step: STEP,
        error: new Error(REASON),
      })
      // A resume refuses a log whose turn was never opened, so the fixture writes the whole bracket.
      session.append('turn/start', { turn: TURN })
      session.append('turn/end', {
        turn: TURN,
        reason: { kind: 'error', error: { message: REASON } },
      })
    })
  })
}
