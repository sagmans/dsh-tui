import type { Context } from '@deepseek-ai/cordis'
import { BoxRenderable, type BaseRenderable, type CliRenderer } from '@opentui/core'
import type { ModelSelection, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { TuiCommandLayer } from '../../contracts/commands.js'
import type { TuiTheme } from '../../contracts/theme.js'
import { createModelSelectionView } from '../../views/model-selection/root.js'
import {
  createModelSelectionController,
  type ModelSelectionController,
  type ModelSelectionControllerOptions,
  type ModelSelectionPort,
  type ModelSelectionResult,
} from './model.js'

const CONTRIBUTION_ID = 'dsh-tui-model-selection'
const CONTRIBUTION_ORDER = 300
const OPEN_COMMAND_LAYER_ID = 'dsh-tui-model-selection-open'
const OVERLAY_COMMAND_LAYER_ID = 'dsh-tui-model-selection-overlay'
const OPEN_COMMAND_PRIORITY = 350
const OVERLAY_COMMAND_PRIORITY = 600
const HIDDEN_SIZE = 0
const SETTINGS_PROVIDERS_COMMAND = 'settings.section.providers'

export const name = 'tui-model-selection'
export const inject: readonly string[] = ['tuiKernel', 'tuiClient']

declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly tuiModelSelection: ModelSelectionController
  }
}

export interface ModelSelectionSeams {
  readonly createController: (options: ModelSelectionControllerOptions) => ModelSelectionController
  readonly createView: (
    renderer: CliRenderer,
    theme: TuiTheme,
    controller: ModelSelectionController,
  ) => BaseRenderable
}

const DEFAULT_SEAMS: ModelSelectionSeams = {
  createController: createModelSelectionController,
  createView: createModelSelectionView,
}

function success<T>(value: T): ModelSelectionResult<T> {
  return { ok: true, value }
}

function failure(error: { readonly code: string; readonly message: string }): ModelSelectionResult<never> {
  return { ok: false, error }
}

function port(ctx: Context): ModelSelectionPort {
  return {
    async models(sessionId) {
      const response = await ctx.tuiClient.api.sessions.models({ sessionId })
      return response.result.ok ? success(response.result.value) : failure(response.result.error)
    },
    async select(sessionId, selection) {
      const response = await ctx.tuiClient.api.sessions.selectModel({
        sessionId,
        provider: selection.provider,
        model: selection.model,
        ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
      })
      return response.result.ok ? success(response.result.value.selected) : failure(response.result.error)
    },
  }
}

function listState(ctx: Context): ModelSelectionControllerOptions['list']['getSnapshot'] extends () => infer T ? T : never {
  const source = ctx.tuiClient.sessions.list.getSnapshot()
  const byId: Record<SessionId, { readonly blank: boolean } | undefined> = {}
  for (const summary of Object.values(source.byId)) {
    if (summary === undefined) continue
    byId[summary.id] = { blank: summary.blank }
  }
  return { byId, current: source.current }
}

function controllerOptions(ctx: Context): ModelSelectionControllerOptions {
  const resources = ctx.tuiKernel.resources
  return {
    available: (sessionId: SessionId) => ctx.tuiClient.sessions.subagentAddress(sessionId) === undefined,
    list: {
      getSnapshot: () => listState(ctx),
      subscribe: listener => ctx.tuiClient.sessions.list.subscribe(listener),
    },
    navigation: resources.navigation,
    openProviders: () => {
      resources.navigation.go('settings')
      queueMicrotask(() => { void resources.commands.run(SETTINGS_PROVIDERS_COMMAND) })
    },
    port: port(ctx),
  }
}

function command(
  commandName: string,
  description: string,
  run: () => void | Promise<void>,
): TuiCommandLayer['commands'][number] {
  return { name: commandName, description, run }
}

export function modelSelectionCommands(
  controller: ModelSelectionController,
  active: () => boolean,
): TuiCommandLayer {
  return {
    id: OVERLAY_COMMAND_LAYER_ID,
    priority: OVERLAY_COMMAND_PRIORITY,
    active,
    commands: [
      command('model-selection.next', 'Select next model option', () => { controller.move(1) }),
      command('model-selection.previous', 'Select previous model option', () => { controller.move(-1) }),
      command('model-selection.select', 'Choose model option', async () => { await controller.activate() }),
      command('model-selection.back', 'Return or close model selection', () => { controller.back() }),
      command('model-selection.close', 'Close model selection', () => { controller.close() }),
      command('model-selection.providers', 'Open provider configuration', () => { controller.openProviders() }),
      command('model-selection.refresh', 'Refresh model catalog', () => controller.refresh()),
    ],
    bindings: [
      { key: 'j', command: 'model-selection.next' },
      { key: 'down', command: 'model-selection.next' },
      { key: 'k', command: 'model-selection.previous' },
      { key: 'up', command: 'model-selection.previous' },
      { key: 'return', command: 'model-selection.select' },
      { key: 'escape', command: 'model-selection.back' },
      { key: 'h', command: 'model-selection.back' },
      { key: 'left', command: 'model-selection.back' },
      { key: 'q', command: 'model-selection.close' },
      { key: 'p', command: 'model-selection.providers' },
      { key: 'r', command: 'model-selection.refresh' },
    ],
  }
}

function openCommands(controller: ModelSelectionController, active: () => boolean): TuiCommandLayer {
  return {
    id: OPEN_COMMAND_LAYER_ID,
    priority: OPEN_COMMAND_PRIORITY,
    active,
    commands: [command('model-selection.open', 'Open session model selection', async () => { await controller.open('composer') })],
    bindings: [{ key: 'alt+m', command: 'model-selection.open' }],
  }
}

function hiddenOverlay(renderer: CliRenderer): BaseRenderable {
  return new BoxRenderable(renderer, {
    id: 'dsh-tui-model-selection-hidden',
    width: HIDDEN_SIZE,
    height: HIDDEN_SIZE,
  })
}

export function mountModelSelection(ctx: Context, seams: ModelSelectionSeams = DEFAULT_SEAMS): void {
  const resources = ctx.tuiKernel.resources
  const controller = seams.createController(controllerOptions(ctx))
  ctx.provide('tuiModelSelection', controller)
  const active = (): boolean => controller.getSnapshot().active
  const noEditor = (): boolean => resources.renderer.currentFocusedEditor === null
    || resources.renderer.currentFocusedEditor === undefined
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
      resources.commands.register(ctx, openCommands(
        controller,
        () => resources.navigation.getSnapshot().route === 'chat'
          && resources.navigation.getSnapshot().overlays.length === 0
          && noEditor(),
      )),
      resources.commands.register(ctx, modelSelectionCommands(controller, () => active() && noEditor())),
      ctx.tuiClient.remote.$on('llm/adapters-updated', () => { void controller.refresh() }),
      ctx.tuiClient.remote.$on('settings/document-updated', () => { void controller.refresh() }),
    )
    ctx.effect(() => () => {
      for (const dispose of disposers.splice(0).toReversed()) dispose()
      controller.dispose()
    }, 'dsh-tui: model selection resources')
  } catch (error) {
    for (const dispose of disposers.toReversed()) dispose()
    controller.dispose()
    throw error
  }
}

export function apply(ctx: Context): void {
  mountModelSelection(ctx)
}

export type { ModelSelection }
