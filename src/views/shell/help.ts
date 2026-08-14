import { BoxRenderable, TextRenderable } from '@opentui/core'
import type { CliRenderer } from '@opentui/core'
import type { ShellController } from '../../features/shell/model.js'
import type { TuiTheme } from '../../contracts/theme.js'

const HELP_WIDTH = '90%'
const HELP_HEIGHT = 11
const HELP_LEFT = '5%'
const HELP_TOP = '4%'
const OVERLAY_Z_INDEX = 100
const HELP_CONTENT = [
  'g c/s/i/,              routes',
  'j/k · Ctrl+N/P         next/previous',
  'Space P · Enter        palette/run',
  '? · z                  help/zen',
  'Esc · q                close/quit',
].join('\n')

export function createHelp(
  renderer: CliRenderer,
  theme: TuiTheme,
  controller: ShellController,
): BoxRenderable {
  const overlay = new BoxRenderable(renderer, {
    id: 'shell-help',
    title: 'KEYS',
    position: 'absolute',
    width: HELP_WIDTH,
    height: HELP_HEIGHT,
    top: HELP_TOP,
    left: HELP_LEFT,
    border: true,
    borderStyle: 'rounded',
    borderColor: theme.colors.focus,
    backgroundColor: theme.colors.background,
    paddingX: 2,
    paddingY: 1,
    zIndex: OVERLAY_Z_INDEX,
  })
  overlay.add(new TextRenderable(renderer, {
    content: HELP_CONTENT,
    fg: theme.colors.text,
    selectable: false,
  }))
  overlay.onMouseUp = event => {
    event.preventDefault()
    event.stopPropagation()
    controller.run('shell.help')
  }
  return overlay
}
