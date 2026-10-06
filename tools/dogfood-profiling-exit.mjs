/** A scratch-only launcher exit proves CLI failure retention without a TTY or a timeout. */
const APP_READY_SERVICE = 'appReady'
const APP_EXIT_SERVICE = 'appExit'
const EXIT_SUCCESS = 0
export const name = 'dogfood-profiling-exit'
export const inject = [APP_READY_SERVICE, APP_EXIT_SERVICE]

/** The real launcher completes disposal and report finalization before the runner rejects its expected outcome. */
export function apply(ctx) {
  ctx.get(APP_READY_SERVICE).onReady(() => ctx.get(APP_EXIT_SERVICE)(EXIT_SUCCESS))
}
