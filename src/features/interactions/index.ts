import type { Context } from '@deepseek-ai/cordis'
import { BoxRenderable, type BaseRenderable, type CliRenderer } from '@opentui/core'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { TuiCommandLayer } from '../../contracts/commands.js'
import type { TuiTheme } from '../../contracts/theme.js'
import { createInteractionsView } from '../../views/interactions/root.js'
import {
  createInteractionsController,
  type InteractionSessionBinding,
  type InteractionsController,
  type InteractionsControllerOptions,
} from './model.js'

const CONTRIBUTION_ID = 'dsh-tui-interactions'
const CONTRIBUTION_ORDER = 200
const COMMAND_LAYER_ID = 'dsh-tui-interactions'
const COMMAND_PRIORITY = 500
const HIDDEN_SIZE = 0

export const name = 'tui-interactions'
export const inject: readonly string[] = ['tuiKernel', 'tuiClient']

export interface InteractionsSeams {
  readonly createController: (options: InteractionsControllerOptions) => InteractionsController
  readonly createView: (
    renderer: CliRenderer,
    theme: TuiTheme,
    controller: InteractionsController,
  ) => BaseRenderable
}

const DEFAULT_SEAMS: InteractionsSeams = {
  createController: createInteractionsController,
  createView: createInteractionsView,
}

function sessionBinding(ctx: Context, id: SessionId): InteractionSessionBinding | undefined {
  const session = ctx.tuiClient.sessions.binding(id)?.session
  return session === undefined
    ? undefined
    : {
        getSnapshot: () => session.getSnapshot(),
        subscribe: listener => session.subscribe(listener),
      }
}

function controllerOptions(ctx: Context): InteractionsControllerOptions {
  return {
    navigation: ctx.tuiKernel.resources.navigation,
    sessions: {
      list: ctx.tuiClient.sessions.list,
      binding: id => sessionBinding(ctx, id),
    },
  }
}

function commandLayer(controller: InteractionsController, active: () => boolean): TuiCommandLayer {
  return {
    id: COMMAND_LAYER_ID,
    priority: COMMAND_PRIORITY,
    active,
    commands: [
      { name: 'interaction.approve', description: 'Approve pending decision', run: () => controller.approve() },
      { name: 'interaction.cancel', description: 'Cancel pending decision', run: () => controller.cancel() },
      { name: 'interaction.next', description: 'Move to next option', run: () => { controller.moveOption(1) } },
      { name: 'interaction.previous', description: 'Move to previous option', run: () => { controller.moveOption(-1) } },
      { name: 'interaction.question-next', description: 'Open next question', run: () => { controller.nextQuestion() } },
      { name: 'interaction.question-previous', description: 'Open previous question', run: () => { controller.previousQuestion() } },
      { name: 'interaction.reject', description: 'Reject pending decision', run: () => controller.reject() },
      { name: 'interaction.select', description: 'Select current option', run: () => { controller.chooseOption() } },
      { name: 'interaction.skip', description: 'Skip current question', run: () => { controller.skipQuestion() } },
      { name: 'interaction.submit', description: 'Submit question answers', run: () => controller.submit() },
    ],
    bindings: [
      { key: 'y', command: 'interaction.approve' },
      { key: 'n', command: 'interaction.reject' },
      { key: 'd', command: 'interaction.cancel' },
      { key: 'escape', command: 'interaction.cancel' },
      { key: 'q', command: 'interaction.cancel' },
      { key: 'j', command: 'interaction.next' },
      { key: 'down', command: 'interaction.next' },
      { key: 'k', command: 'interaction.previous' },
      { key: 'up', command: 'interaction.previous' },
      { key: 'l', command: 'interaction.question-next' },
      { key: 'right', command: 'interaction.question-next' },
      { key: 'h', command: 'interaction.question-previous' },
      { key: 'left', command: 'interaction.question-previous' },
      { key: 'space', command: 'interaction.select' },
      { key: 's', command: 'interaction.skip' },
      { key: 'ctrl+return', command: 'interaction.submit' },
    ],
  }
}

function hiddenOverlay(renderer: CliRenderer): BaseRenderable {
  return new BoxRenderable(renderer, {
    id: 'dsh-tui-interactions-hidden',
    width: HIDDEN_SIZE,
    height: HIDDEN_SIZE,
  })
}

export function mountInteractions(ctx: Context, seams: InteractionsSeams = DEFAULT_SEAMS): void {
  const resources = ctx.tuiKernel.resources
  const controller = seams.createController(controllerOptions(ctx))
  const active = (): boolean => {
    const overlayId = controller.getSnapshot().overlayId
    return overlayId !== undefined
      && resources.navigation.getSnapshot().overlays.at(-1)?.id === overlayId
  }
  const disposers: Array<() => void> = []
  try {
    disposers.push(
      resources.slots.register(ctx, {
        id: CONTRIBUTION_ID,
        order: CONTRIBUTION_ORDER,
        slots: {
          overlay: () => active()
            ? seams.createView(resources.renderer, resources.theme, controller)
            : hiddenOverlay(resources.renderer),
        },
      }),
      resources.commands.register(ctx, commandLayer(
        controller,
        () => active()
          && (resources.renderer.currentFocusedEditor === null
            || resources.renderer.currentFocusedEditor === undefined),
      )),
    )
    ctx.effect(() => () => { controller.dispose() }, 'dsh-tui: interactions controller')
  } catch (error) {
    controller.dispose()
    for (const dispose of disposers.toReversed()) dispose()
    throw error
  }
}

export function apply(ctx: Context): void {
  mountInteractions(ctx)
}
