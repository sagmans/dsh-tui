/** One reversible terminal mutation. */
export type RestoreHook = () => void

/** Registry that guarantees every registered hook runs exactly once. */
export interface RestoreRegistry {
  add(hook: RestoreHook): () => void
  restore(): void
  readonly size: number
}

/**
 * Collect the terminal-release hooks for one surface.
 *
 * Restoring the terminal is the one thing that must happen even when boot
 * fails halfway, so hooks run in reverse registration order, each isolated:
 * a throwing hook must not strand the ones registered before it.
 */
export function createRestoreRegistry(): RestoreRegistry {
  const hooks: RestoreHook[] = []
  let restored = false
  return {
    add(hook) {
      if (restored) {
        // Registering after release means the owner is already gone; run it now
        // rather than silently keeping a mutation the terminal never reclaims.
        hook()
        return () => {}
      }
      hooks.push(hook)
      return () => {
        const index = hooks.indexOf(hook)
        if (index >= 0) hooks.splice(index, 1)
      }
    },
    restore() {
      restored = true
      while (hooks.length > 0) {
        const hook = hooks.pop()
        try {
          hook?.()
        } catch {
          // A failing hook must not prevent the remaining ones from running.
        }
      }
    },
    get size() {
      return hooks.length
    },
  }
}
