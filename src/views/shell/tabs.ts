import { BoxRenderable, MouseButton, TextAttributes, TextRenderable } from '@opentui/core'
import type { CliRenderer } from '@opentui/core'
import type { ShellController } from '../../features/shell/model.js'
import type { TuiRoute } from '../../kernel/navigation.js'
import type { TuiTheme } from '../../contracts/theme.js'

const TAB_HEIGHT = 1

interface RouteTab {
  readonly label: string
  readonly route: TuiRoute
  readonly width: number
}

const ROUTE_TABS: readonly RouteTab[] = [
  { label: 'CHAT', route: 'chat', width: 10 },
  { label: 'SESSIONS', route: 'sessions', width: 14 },
  { label: 'INSPECT', route: 'inspect', width: 12 },
  { label: 'SETTINGS', route: 'settings', width: 14 },
]

export function createRouteTabs(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: ShellController,
): BoxRenderable {
  const row = new BoxRenderable(renderer, {
    id: 'shell-tabs',
    flexDirection: 'row',
    height: TAB_HEIGHT,
  })
  const current = controller.getSnapshot().route

  for (const tab of ROUTE_TABS) {
    const active = tab.route === current
    const node = new TextRenderable(renderer, {
      id: `shell-tab-${tab.route}`,
      content: ` ${tab.label} `,
      width: tab.width,
      height: TAB_HEIGHT,
      fg: active ? theme.colors.focus : theme.colors.muted,
      attributes: active ? TextAttributes.BOLD : 0,
      selectable: false,
      onMouseUp(event) {
        // OpenTUI publishes equivalent mouse-button values through separate enum declarations.
        // oxlint-disable-next-line typescript/no-unsafe-enum-comparison
        if (event.button !== MouseButton.LEFT) return
        event.preventDefault()
        event.stopPropagation()
        controller.openRoute(tab.route)
      },
    })
    row.add(node)
  }
  return row
}
