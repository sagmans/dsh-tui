import type { Context } from '@deepseek-ai/cordis'
import { BoxRenderable, type BaseRenderable, type CliRenderer } from '@opentui/core'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { TuiCommandLayer } from '../../contracts/commands.js'
import type { TuiTheme } from '../../contracts/theme.js'
import type { TuiClientFacade } from '../../client/context.js'
import { createTrajectoryView } from '../../views/trajectory/root.js'
import {
  createTrajectoryController,
  type TrajectoryController,
  type TrajectoryControllerOptions,
  type TrajectoryListState,
  type TrajectorySessionsSource,
} from './model.js'

const CONTRIBUTION_ID = 'dsh-tui-trajectory'
const CONTRIBUTION_ORDER = 350
const GLOBAL_LAYER_ID = 'dsh-tui-trajectory-global'
const GLOBAL_PRIORITY = 360
const OVERLAY_LAYER_ID = 'dsh-tui-trajectory-overlay'
const OVERLAY_PRIORITY = 650
const OPEN_BINDING = 'alt+t'
const HIDDEN_SIZE = 0

export const name = 'tui-trajectory'
export const inject: readonly string[] = ['tuiKernel', 'tuiClient']

declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly tuiTrajectory: TrajectoryController
  }
}

export interface TrajectorySeams {
  readonly createController: (options: TrajectoryControllerOptions) => TrajectoryController
  readonly createView: (
    renderer: CliRenderer,
    theme: TuiTheme,
    controller: TrajectoryController,
  ) => BaseRenderable
}

const DEFAULT_SEAMS: TrajectorySeams = {
  createController: createTrajectoryController,
  createView: createTrajectoryView,
}

function listState(client: TuiClientFacade): TrajectoryListState {
  return { current: client.sessions.list.getSnapshot().current }
}

function sessionsSource(client: TuiClientFacade): TrajectorySessionsSource {
  return {
    list: {
      getSnapshot: () => listState(client),
      subscribe: listener => client.sessions.list.subscribe(listener),
    },
    binding(id: SessionId) {
      const session = client.sessions.binding(id)?.session
      return session === undefined
        ? undefined
        : {
            getSnapshot: () => session.getSnapshot(),
            subscribe: listener => session.subscribe(listener),
            loadOlder: () => session.loadOlder(),
          }
    },
  }
}

function command(
  commandName: string,
  description: string,
  run: () => void | Promise<void>,
): TuiCommandLayer['commands'][number] {
  return { name: commandName, description, run }
}

export function trajectoryCommands(
  controller: TrajectoryController,
  active: () => boolean,
): TuiCommandLayer {
  return {
    id: OVERLAY_LAYER_ID,
    priority: OVERLAY_PRIORITY,
    active,
    commands: [
      command('trajectory.close', 'Close trajectory ledger', () => { controller.close() }),
      command('trajectory.next', 'Select next trajectory row', () => { controller.move(1) }),
      command('trajectory.previous', 'Select previous trajectory row', () => { controller.move(-1) }),
      command('trajectory.fold', 'Fold or expand selected trajectory group', () => { controller.toggleFold() }),
      command('trajectory.search', 'Search complete trajectory details', () => { controller.openSearch() }),
      command('trajectory.clear-search', 'Clear trajectory search', () => { controller.clearSearch() }),
      command('trajectory.older', 'Load earlier trajectory history', async () => { await controller.loadOlder() }),
      command('trajectory.next-detail', 'Open next trajectory detail tab', () => { controller.moveDetailTab(1) }),
      command('trajectory.previous-detail', 'Open previous trajectory detail tab', () => { controller.moveDetailTab(-1) }),
      command('trajectory.detail.input', 'Inspect trajectory input', () => { controller.selectDetailTab('input') }),
      command('trajectory.detail.output', 'Inspect trajectory output', () => { controller.selectDetailTab('output') }),
      command('trajectory.detail.timing', 'Inspect trajectory timing', () => { controller.selectDetailTab('timing') }),
      command('trajectory.detail.raw', 'Inspect raw trajectory record', () => { controller.selectDetailTab('raw') }),
      command('trajectory.timeline', 'Toggle sequence or chronological timeline', () => { controller.toggleTimelineMode() }),
    ],
    bindings: [
      { key: 'escape', command: 'trajectory.close' },
      { key: 'q', command: 'trajectory.close' },
      { key: 'j', command: 'trajectory.next' },
      { key: 'down', command: 'trajectory.next' },
      { key: 'k', command: 'trajectory.previous' },
      { key: 'up', command: 'trajectory.previous' },
      { key: 'z', command: 'trajectory.fold' },
      { key: 'space', command: 'trajectory.fold' },
      { key: '/', command: 'trajectory.search' },
      { key: 'ctrl+l', command: 'trajectory.clear-search' },
      { key: 'pageup', command: 'trajectory.older' },
      { key: ']', command: 'trajectory.next-detail' },
      { key: '[', command: 'trajectory.previous-detail' },
      { key: '1', command: 'trajectory.detail.input' },
      { key: '2', command: 'trajectory.detail.output' },
      { key: '3', command: 'trajectory.detail.timing' },
      { key: '4', command: 'trajectory.detail.raw' },
      { key: 't', command: 'trajectory.timeline' },
    ],
  }
}

function globalCommands(controller: TrajectoryController, active: () => boolean): TuiCommandLayer {
  return {
    id: GLOBAL_LAYER_ID,
    priority: GLOBAL_PRIORITY,
    active,
    commands: [command('trajectory.open', 'Open trajectory ledger', () => controller.open())],
    bindings: [{ key: OPEN_BINDING, command: 'trajectory.open' }],
  }
}

function hiddenOverlay(renderer: CliRenderer): BaseRenderable {
  return new BoxRenderable(renderer, {
    id: 'dsh-tui-trajectory-hidden',
    width: HIDDEN_SIZE,
    height: HIDDEN_SIZE,
  })
}

export function mountTrajectory(ctx: Context, seams: TrajectorySeams = DEFAULT_SEAMS): void {
  const resources = ctx.tuiKernel.resources
  const controller = seams.createController({
    navigation: resources.navigation,
    sessions: sessionsSource(ctx.tuiClient),
  })
  ctx.provide('tuiTrajectory', controller)
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
      resources.commands.register(ctx, globalCommands(
        controller,
        () => !active() && resources.navigation.getSnapshot().overlays.length === 0 && noEditor(),
      )),
      resources.commands.register(ctx, trajectoryCommands(controller, () => active() && noEditor())),
    )
    ctx.effect(() => () => {
      for (const dispose of disposers.splice(0).toReversed()) dispose()
      controller.dispose()
    }, 'dsh-tui: trajectory resources')
  } catch (error) {
    for (const dispose of disposers.toReversed()) dispose()
    controller.dispose()
    throw error
  }
}

export function apply(ctx: Context): void {
  mountTrajectory(ctx)
}
