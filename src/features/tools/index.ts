import type { Context } from '@deepseek-ai/cordis'
import type { BaseRenderable, CliRenderer } from '@opentui/core'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { TuiCommandLayer } from '../../contracts/commands.js'
import type { TuiTheme } from '../../contracts/theme.js'
import { createToolsView } from '../../views/tools/root.js'
import {
  createToolsController,
  type ToolsController,
  type ToolsControllerOptions,
  type ToolsSessionBinding,
} from './model.js'

const CONTRIBUTION_ID = 'dsh-tui-tools'
const CONTRIBUTION_ORDER = 100
const COMMAND_LAYER_ID = 'dsh-tui-tools'
const COMMAND_PRIORITY = 350

export const name = 'tui-tools'
export const inject: readonly string[] = ['tuiKernel', 'tuiClient']

export interface ToolsSeams {
  readonly createController: (options: ToolsControllerOptions) => ToolsController
  readonly createView: (
    renderer: CliRenderer,
    theme: TuiTheme,
    controller: ToolsController,
  ) => BaseRenderable
}

const DEFAULT_SEAMS: ToolsSeams = {
  createController: createToolsController,
  createView: createToolsView,
}

function sessionBinding(ctx: Context, id: SessionId): ToolsSessionBinding | undefined {
  const session = ctx.tuiClient.sessions.binding(id)?.session
  return session === undefined
    ? undefined
    : {
        getSnapshot: () => session.getSnapshot(),
        subscribe: listener => session.subscribe(listener),
      }
}

function controllerOptions(ctx: Context): ToolsControllerOptions {
  return {
    openPath: path => ctx.tuiClient.workspaces.openPath(path),
    sessions: {
      list: ctx.tuiClient.sessions.list,
      binding: id => sessionBinding(ctx, id),
    },
  }
}

function commandLayer(controller: ToolsController, active: () => boolean): TuiCommandLayer {
  return {
    id: COMMAND_LAYER_ID,
    priority: COMMAND_PRIORITY,
    active,
    commands: [
      { name: 'tools.next', description: 'Select next tool call', run: () => { controller.move(1) } },
      { name: 'tools.previous', description: 'Select previous tool call', run: () => { controller.move(-1) } },
      { name: 'tools.file-next', description: 'Select next produced file', run: () => { controller.movePath(1) } },
      { name: 'tools.file-previous', description: 'Select previous produced file', run: () => { controller.movePath(-1) } },
      { name: 'tools.toggle', description: 'Fold selected nested tool call', run: () => { controller.toggleSelected() } },
      { name: 'tools.open', description: 'Confirm external open for selected produced file', run: async () => { await controller.openSelected() } },
    ],
    bindings: [
      { key: 'j', command: 'tools.next' },
      { key: 'down', command: 'tools.next' },
      { key: 'k', command: 'tools.previous' },
      { key: 'up', command: 'tools.previous' },
      { key: ']', command: 'tools.file-next' },
      { key: '[', command: 'tools.file-previous' },
      { key: 'return', command: 'tools.toggle' },
      { key: 'o', command: 'tools.open' },
    ],
  }
}

export function mountTools(ctx: Context, seams: ToolsSeams = DEFAULT_SEAMS): void {
  const resources = ctx.tuiKernel.resources
  const controller = seams.createController(controllerOptions(ctx))
  const disposers: Array<() => void> = []
  try {
    disposers.push(
      resources.slots.register(ctx, {
        id: CONTRIBUTION_ID,
        order: CONTRIBUTION_ORDER,
        slots: {
          'route.inspect': () => seams.createView(resources.renderer, resources.theme, controller),
        },
      }),
      resources.commands.register(ctx, commandLayer(
        controller,
        () => resources.navigation.getSnapshot().route === 'inspect'
          && resources.navigation.getSnapshot().overlays.length === 0
          && (resources.renderer.currentFocusedEditor === null
            || resources.renderer.currentFocusedEditor === undefined),
      )),
    )
    ctx.effect(() => () => { controller.dispose() }, 'dsh-tui: tools controller')
  } catch (error) {
    controller.dispose()
    for (const dispose of disposers.toReversed()) dispose()
    throw error
  }
}

export function apply(ctx: Context): void {
  mountTools(ctx)
}
