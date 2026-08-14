import type { Context } from '@deepseek-ai/cordis'
import type { BaseRenderable, CliRenderer } from '@opentui/core'
import type { TuiTheme } from '../../contracts/theme.js'
import type { TuiLocale } from '../../services/locale.js'
import { createSettingsView } from '../../views/settings/root.js'
import { settingsCommands } from './commands.js'
import {
  createSettingsController,
  type ConfigurationController,
  type ConfigurationControllerOptions,
} from './model.js'
import { configurationListState, createConfigurationPort } from './port.js'

const CONTRIBUTION_ID = 'dsh-tui-settings'
const CONTRIBUTION_ORDER = 100

export const name = 'tui-settings'
export const inject: readonly string[] = ['tuiKernel', 'tuiClient']

export interface SettingsSeams {
  readonly createController: (options: ConfigurationControllerOptions) => ConfigurationController
  readonly createView: (
    renderer: CliRenderer,
    theme: TuiTheme,
    locale: TuiLocale,
    controller: ConfigurationController,
  ) => BaseRenderable
}

const DEFAULT_SEAMS: SettingsSeams = {
  createController: createSettingsController,
  createView: createSettingsView,
}

function subscribeHostEvents(
  ctx: Context,
  controller: ConfigurationController,
  routeActive: () => boolean,
): readonly (() => void)[] {
  const refresh = (): void => { if (routeActive()) void controller.refresh() }
  const refreshSettings = (): void => {
    void controller.syncPreferences()
    refresh()
  }
  return [
    ctx.tuiClient.remote.$on('settings/document-updated', refreshSettings),
    ctx.tuiClient.remote.$on('credentials/updated', refresh),
    ctx.tuiClient.remote.$on('llm/adapters-updated', refresh),
    ctx.tuiClient.remote.$on('agent-preset/selected', refresh),
    ctx.tuiClient.remote.$on('cordis/dynamic-package', refresh),
    ctx.tuiClient.remote.$on('cordis/dynamic-retract', refresh),
  ]
}

export function mountSettings(ctx: Context, seams: SettingsSeams = DEFAULT_SEAMS): void {
  const resources = ctx.tuiKernel.resources
  const controller = seams.createController({
    list: {
      getSnapshot: () => configurationListState(ctx.tuiClient),
      subscribe: listener => ctx.tuiClient.sessions.list.subscribe(listener),
    },
    locale: resources.locale,
    navigation: resources.navigation,
    port: createConfigurationPort(ctx.tuiClient),
    theme: resources.theme,
  })
  const routeActive = (): boolean => resources.navigation.getSnapshot().route === 'settings'
  const commandActive = (): boolean => routeActive()
    && (resources.renderer.currentFocusedEditor === null || resources.renderer.currentFocusedEditor === undefined)
  const disposers: Array<() => void> = []
  try {
    disposers.push(
      resources.slots.register(ctx, {
        id: CONTRIBUTION_ID,
        order: CONTRIBUTION_ORDER,
        slots: {
          'route.settings': () => seams.createView(
            resources.renderer,
            resources.theme,
            resources.locale,
            controller,
          ),
        },
      }),
      resources.commands.register(ctx, settingsCommands(
        controller,
        () => { resources.navigation.go('chat') },
        commandActive,
      )),
      ...subscribeHostEvents(ctx, controller, routeActive),
    )
    void controller.syncPreferences()
    if (routeActive()) void controller.activate()
    ctx.effect(() => () => {
      for (const dispose of disposers.splice(0).toReversed()) dispose()
      controller.dispose()
    }, 'dsh-tui: settings resources')
  } catch (error) {
    for (const dispose of disposers.toReversed()) dispose()
    controller.dispose()
    throw error
  }
}

export function apply(ctx: Context): void {
  mountSettings(ctx)
}
