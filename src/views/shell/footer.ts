import { BoxRenderable, MouseButton, TextAttributes, TextRenderable } from '@opentui/core'
import type { CliRenderer } from '@opentui/core'
import type { ShellActionCommandName, ShellController } from '../../features/shell/model.js'
import type { TuiTheme } from '../../contracts/theme.js'

const FOOTER_HEIGHT = 1

interface FooterAction {
  readonly command: ShellActionCommandName
  readonly label: string
  readonly width: number
}

const FOOTER_ACTIONS: readonly FooterAction[] = [
  { command: 'session.previous', label: 'K PREV', width: 9 },
  { command: 'session.next', label: 'J NEXT', width: 9 },
  { command: 'shell.palette', label: 'SPC P COMMANDS', width: 16 },
  { command: 'shell.help', label: '? HELP', width: 9 },
  { command: 'shell.zen', label: 'Z ZEN', width: 8 },
  { command: 'shell.quit', label: 'Q QUIT', width: 8 },
]

export function createFooterActions(
  renderer: CliRenderer,
  theme: TuiTheme,
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
      content: ` ${action.label} `,
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
