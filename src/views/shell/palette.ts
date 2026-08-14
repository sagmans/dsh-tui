import { BoxRenderable, MouseButton, TextAttributes, TextRenderable } from '@opentui/core'
import type { CliRenderer } from '@opentui/core'
import type { PaletteCommandName, ShellController } from '../../features/shell/model.js'
import { PALETTE_COMMANDS, shellCommandDescription } from '../../features/shell/model.js'
import type { TuiTheme } from '../../contracts/theme.js'
import type { TuiLocale } from '../../services/locale.js'

const PALETTE_WIDTH = '86%'
const PALETTE_HEIGHT = 11
const PALETTE_LEFT = '7%'
const PALETTE_TOP = '16%'
const OVERLAY_Z_INDEX = 100
const PALETTE_ROW_HEIGHT = 1
const PALETTE_KEY_WIDTH = 8
const PALETTE_LABELS: Readonly<Record<PaletteCommandName, string>> = Object.freeze({
  'route.chat': 'g c',
  'route.sessions': 'g s',
  'route.inspect': 'g i',
  'route.settings': 'g ,',
  'shell.help': '?',
  'shell.zen': 'z',
  'shell.quit': 'q',
})

export function createPalette(
  renderer: CliRenderer,
  theme: TuiTheme,
  locale: TuiLocale,
  controller: ShellController,
): BoxRenderable {
  const overlay = new BoxRenderable(renderer, {
    id: 'shell-palette',
    title: locale.t('shell.palette.title'),
    position: 'absolute',
    width: PALETTE_WIDTH,
    height: PALETTE_HEIGHT,
    top: PALETTE_TOP,
    left: PALETTE_LEFT,
    border: true,
    borderStyle: 'rounded',
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.background,
    paddingX: 2,
    paddingY: 1,
    zIndex: OVERLAY_Z_INDEX,
  })
  const selected = controller.getSnapshot().paletteCommand
  for (const command of PALETTE_COMMANDS) {
    const active = command === selected
    overlay.add(new TextRenderable(renderer, {
      id: `shell-palette-${command}`,
      content: `${active ? '›' : ' '} ${PALETTE_LABELS[command].padEnd(PALETTE_KEY_WIDTH)} ${shellCommandDescription(command, locale)}`,
      height: PALETTE_ROW_HEIGHT,
      fg: active ? theme.colors.focus : theme.colors.text,
      attributes: active ? TextAttributes.BOLD : TextAttributes.DIM,
      selectable: false,
      onMouseUp(event) {
        // OpenTUI publishes equivalent mouse-button values through separate enum declarations.
        // oxlint-disable-next-line typescript/no-unsafe-enum-comparison
        if (event.button !== MouseButton.LEFT) return
        event.preventDefault()
        event.stopPropagation()
        while (controller.getSnapshot().paletteCommand !== command) controller.run('palette.next')
        controller.run('palette.run')
      },
    }))
  }
  return overlay
}
