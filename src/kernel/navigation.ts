export type TuiRoute = 'chat' | 'inspect' | 'sessions' | 'settings'

export interface TuiOverlay {
  readonly id: string
  readonly restoreFocus?: string
}

export interface TuiNavigationSnapshot {
  readonly route: TuiRoute
  readonly previousRoute: TuiRoute | undefined
  readonly overlays: readonly TuiOverlay[]
}

export interface TuiNavigationStore {
  back(): void
  closeOverlay(): TuiOverlay | undefined
  getSnapshot(): TuiNavigationSnapshot
  go(route: TuiRoute): void
  openOverlay(overlay: TuiOverlay): void
  subscribe(listener: () => void): () => void
}

const DEFAULT_ROUTE: TuiRoute = 'chat'

class NavigationStore implements TuiNavigationStore {
  private readonly listeners = new Set<() => void>()
  private snapshot: TuiNavigationSnapshot = Object.freeze({
    route: DEFAULT_ROUTE,
    previousRoute: undefined,
    overlays: Object.freeze([]),
  })

  back(): void {
    const route = this.snapshot.previousRoute
    if (route === undefined) return
    this.publish({ route, previousRoute: this.snapshot.route, overlays: this.snapshot.overlays })
  }

  closeOverlay(): TuiOverlay | undefined {
    const closed = this.snapshot.overlays.at(-1)
    if (closed === undefined) return undefined
    this.publish({ ...this.snapshot, overlays: this.snapshot.overlays.slice(0, -1) })
    return closed
  }

  getSnapshot(): TuiNavigationSnapshot {
    return this.snapshot
  }

  go(route: TuiRoute): void {
    if (route === this.snapshot.route) return
    this.publish({ route, previousRoute: this.snapshot.route, overlays: this.snapshot.overlays })
  }

  openOverlay(overlay: TuiOverlay): void {
    this.publish({ ...this.snapshot, overlays: [...this.snapshot.overlays, Object.freeze({ ...overlay })] })
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private publish(snapshot: TuiNavigationSnapshot): void {
    this.snapshot = Object.freeze({ ...snapshot, overlays: Object.freeze([...snapshot.overlays]) })
    for (const listener of this.listeners) listener()
  }
}

export function createNavigationStore(): TuiNavigationStore {
  return new NavigationStore()
}
