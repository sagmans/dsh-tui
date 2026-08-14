import { MouseButton, TextAttributes, TextRenderable } from '@opentui/core'
import type { CliRenderer } from '@opentui/core'
import type { ShellController, ShellSnapshot } from '../../features/shell/model.js'
import type { TuiTheme } from '../../contracts/theme.js'
import type { TuiLocale } from '../../services/locale.js'

const STATUS_HEIGHT = 1

export function createStatusLine(
  renderer: CliRenderer,
  theme: TuiTheme,
  locale: TuiLocale,
  snapshot: ShellSnapshot,
  controller: ShellController,
): TextRenderable {
  const title = snapshot.activeSessionTitle ?? locale.t('shell.status.noSession')
  const state = snapshot.activeSessionRunning
    ? locale.t('shell.status.running')
    : locale.t('shell.status.idle')
  return new TextRenderable(renderer, {
    id: 'shell-status',
    content: `${title}  ·  ${state}`,
    fg: snapshot.activeSessionRunning ? theme.colors.success : theme.colors.muted,
    attributes: TextAttributes.DIM,
    height: STATUS_HEIGHT,
    truncate: true,
    selectable: false,
    onMouseUp(event) {
      // Status remains visible in zen mode, preserving a mouse path back to full chrome.
      // oxlint-disable-next-line typescript/no-unsafe-enum-comparison
      if (event.button !== MouseButton.LEFT) return
      event.preventDefault()
      event.stopPropagation()
      controller.run('shell.zen')
    },
  })
}
