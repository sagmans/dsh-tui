/**
 * Real session and agent events prove which failure text reaches the screen and which reaches an
 * export, with no model route and so no billing.
 */
const SESSION_EVENT = 'session/event'
const TITLE_EVENT = 'session/title'
const AGENT_ERROR_EVENT = 'agent/error'
const REQUEST_TITLE = 'failure-notices-request'
const REASON = 'dogfood-failure-reason'
const TURN = 1
const STEP = 1
export const name = 'dogfood-failure-notices'
export const inject = ['sessions']

/** The runner mounts this fixture only in its own credential-free home and triggers it with a local rename. */
export function apply(ctx) {
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
      session.append('turn/end', {
        turn: TURN,
        reason: { kind: 'error', error: { message: REASON } },
      })
    })
  })
}
