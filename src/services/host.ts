import type { CliRenderer } from '@opentui/core'
import type { TuiNavigationStore, TuiOverlay } from '../kernel/navigation.js'

export interface TuiHost {
  readonly navigation: TuiNavigationStore
  readonly renderer: CliRenderer
  closeOverlay(): TuiOverlay | undefined
  openOverlay(overlay: TuiOverlay): void
}

class HostService implements TuiHost {
  readonly navigation: TuiNavigationStore
  readonly renderer: CliRenderer

  constructor(renderer: CliRenderer, navigation: TuiNavigationStore) {
    this.navigation = navigation
    this.renderer = renderer
  }

  closeOverlay(): TuiOverlay | undefined {
    const overlay = this.navigation.closeOverlay()
    if (overlay?.restoreFocus !== undefined) {
      this.renderer.root.findDescendantById(overlay.restoreFocus)?.focus()
    }
    return overlay
  }

  openOverlay(overlay: TuiOverlay): void {
    const restoreFocus = overlay.restoreFocus ?? this.renderer.currentFocusedRenderable?.id
    this.navigation.openOverlay({
      ...overlay,
      ...restoreFocus === undefined ? {} : { restoreFocus },
    })
  }
}

export function createTuiHost(renderer: CliRenderer, navigation: TuiNavigationStore): TuiHost {
  return new HostService(renderer, navigation)
}
