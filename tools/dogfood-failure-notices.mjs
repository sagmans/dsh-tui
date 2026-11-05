/**
 * Real session and agent events prove which failure and outside text reaches the screen and which
 * reaches an export, with no model route and so no billing.
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
const SUCCESS_COMMAND = 'outside-success'
const OUTSIDE_TEXT = 'dogfood-outside-text'
const SUCCESS_TEXT = `${OUTSIDE_TEXT}-success`
const TODO_TEXT = `${OUTSIDE_TEXT}-todo`
const INJECTED_TEXT = `${OUTSIDE_TEXT}-injected`
const ACTION_TEXT = `${OUTSIDE_TEXT}-action`
const INJECTED_SOURCE = 'dogfood-legacy-source'
// A resume refuses a stored message with no id or role.
const INJECTED_MESSAGE_ID = 'dogfood-injected-message'
const USER_ROLE = 'user'
const ACTION_ID = 'plugin.dogfood.outside-notice'
const ACTION_KEY = 'z'
export const name = 'dogfood-failure-notices'
export const inject = ['sessions', 'commands', 'tuiKeymaps']

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
  // Text a plugin answers with on success is as unknown to the surface as a failure reason.
  ctx.commands.register({
    name: SUCCESS_COMMAND,
    description: 'Answer with text that names a fake value',
    handler: () => ({ kind: 'success', text: SUCCESS_TEXT }),
  })
  ctx.tuiKeymaps.register(ctx, {
    id: ACTION_ID,
    layer: 'chord',
    defaultKeys: [ACTION_KEY],
    label: 'Post a notice that names a fake value',
    handler: async (ports) => ports.notice(ACTION_TEXT),
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
      // After the turn opens, because that clears the plan; no source form makes this the legacy row.
      session.append('todo/write', { todos: [{ content: TODO_TEXT, status: 'pending' }] })
      session.append(
        'user/message',
        {
          id: INJECTED_MESSAGE_ID,
          role: USER_ROLE,
          content: [{ type: 'text', text: INJECTED_TEXT }],
          source: { kind: INJECTED_SOURCE },
        },
        { surfaceOp: 'append' },
      )
      session.append('turn/end', {
        turn: TURN,
        reason: { kind: 'error', error: { message: REASON } },
      })
    })
  })
}
