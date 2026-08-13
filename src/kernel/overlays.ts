import type { TuiNavigationStore, TuiOverlay } from './navigation.js'

export interface TuiOverlayController {
  close(): TuiOverlay | undefined
  open(overlay: TuiOverlay): void
}

export function createOverlayController(navigation: TuiNavigationStore): TuiOverlayController {
  return Object.freeze({
    close: () => navigation.closeOverlay(),
    open: (overlay: TuiOverlay) => { navigation.openOverlay(overlay) },
  })
}
