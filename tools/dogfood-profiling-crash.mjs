/** A real unhandled exception proves fatal restoration and report privacy without changing production code. */
const SESSION_EVENT = 'session/event'
const TITLE_EVENT = 'session/title'
const CRASH_TITLE = 'profiling-crash-request'
const PRIVATE_ERROR = 'profiling-private-fatal-marker'
export const name = 'dogfood-profiling-crash'
export const inject = ['sessions']

/** The runner mounts this fixture only in its own credential-free home and triggers it with a local rename. */
export function apply(ctx) {
  let requested = false
  ctx.on(SESSION_EVENT, (_session, event) => {
    if (requested || event.type !== TITLE_EVENT || event.data.title !== CRASH_TITLE) return
    requested = true
    // Throw after publication finishes so this exercises process-fatal cleanup, not command error reporting.
    queueMicrotask(() => { throw new Error(PRIVATE_ERROR) })
  })
}
