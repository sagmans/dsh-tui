/** A real plugin failure proves the surface names it on screen, not only in the stderr report held until exit. */
const FAILURE = 'dogfood-inactive-plugin-failure'
export const name = 'dogfood-inactive-plugin'

/** The runner mounts this fixture only in its own credential-free home. */
export function apply() {
  throw new Error(FAILURE)
}
