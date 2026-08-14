import { BoxRenderable, MouseButton, TextAttributes, TextRenderable } from '@opentui/core'
import type { CliRenderer } from '@opentui/core'
import type { ShellActionCommandName, ShellController } from '../../features/shell/model.js'
import type { TuiTheme } from '../../contracts/theme.js'
import type { LocaleKey } from '../../locales/en.js'
import type { TuiLocale } from '../../services/locale.js'

const FOOTER_HEIGHT = 1

interface FooterAction {
  readonly command: ShellActionCommandName
  readonly labelKey: LocaleKey
  readonly width: number
}

const FOOTER_ACTIONS: readonly FooterAction[] = [
  { command: 'session.previous', labelKey: 'shell.footer.previous', width: 9 },
  { command: 'session.next', labelKey: 'shell.footer.next', width: 9 },
  { command: 'shell.palette', labelKey: 'shell.footer.commands', width: 16 },
  { command: 'shell.help', labelKey: 'shell.footer.help', width: 9 },
  { command: 'shell.zen', labelKey: 'shell.footer.zen', width: 8 },
  { command: 'shell.quit', labelKey: 'shell.footer.quit', width: 8 },
]

export function createFooterActions(
  renderer: CliRenderer,
  theme: TuiTheme,
  locale: TuiLocale,
  controller: ShellController,
): BoxRenderable {
  const row = new BoxRenderable(renderer, {
    id: 'shell-footer',
    flexDirection: 'row',
    height: FOOTER_HEIGHT,
    overflow: 'hidden',
  })

  for (const action of FOOTER_ACTIONS) {
    row.add(new TextRenderable(renderer, {
      id: `shell-footer-${action.command}`,
      content: ` ${locale.t(action.labelKey)} `,
      width: action.width,
      height: FOOTER_HEIGHT,
      fg: theme.colors.muted,
      attributes: TextAttributes.DIM,
      selectable: false,
      onMouseUp(event) {
        // OpenTUI publishes equivalent mouse-button values through separate enum declarations.
        // oxlint-disable-next-line typescript/no-unsafe-enum-comparison
        if (event.button !== MouseButton.LEFT) return
        event.preventDefault()
        event.stopPropagation()
        controller.run(action.command)
      },
    }))
  }

  return row
}
