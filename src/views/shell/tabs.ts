import { BoxRenderable, MouseButton, TextAttributes, TextRenderable } from '@opentui/core'
import type { CliRenderer } from '@opentui/core'
import type { ShellController } from '../../features/shell/model.js'
import type { TuiRoute } from '../../kernel/navigation.js'
import type { TuiTheme } from '../../contracts/theme.js'
import type { LocaleKey } from '../../locales/en.js'
import type { TuiLocale } from '../../services/locale.js'

const TAB_HEIGHT = 1

interface RouteTab {
  readonly labelKey: LocaleKey
  readonly route: TuiRoute
  readonly width: number
}

const ROUTE_TABS: readonly RouteTab[] = [
  { labelKey: 'shell.route.chat', route: 'chat', width: 10 },
  { labelKey: 'shell.route.sessions', route: 'sessions', width: 14 },
  { labelKey: 'shell.route.inspect', route: 'inspect', width: 12 },
  { labelKey: 'shell.route.settings', route: 'settings', width: 14 },
]

export function createRouteTabs(
  renderer: CliRenderer,
  theme: TuiTheme,
  locale: TuiLocale,
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
      content: ` ${locale.t(tab.labelKey)} `,
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
