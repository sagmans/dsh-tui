import { MouseButton, TextAttributes, TextRenderable } from '@opentui/core'
import type { CliRenderer } from '@opentui/core'
import type { ShellController, ShellSnapshot } from '../../features/shell/model.js'
import type { TuiTheme } from '../../contracts/theme.js'

const EMPTY_SESSION_TITLE = 'No session'
const IDLE_STATUS = 'idle'
const RUNNING_STATUS = 'running'
const STATUS_HEIGHT = 1

export function createStatusLine(
  renderer: CliRenderer,
  theme: TuiTheme,
  snapshot: ShellSnapshot,
  controller: ShellController,
): TextRenderable {
  const title = snapshot.activeSessionTitle ?? EMPTY_SESSION_TITLE
  const state = snapshot.activeSessionRunning ? RUNNING_STATUS : IDLE_STATUS
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
