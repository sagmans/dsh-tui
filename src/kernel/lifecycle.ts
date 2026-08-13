import type { Context } from '@deepseek-ai/cordis'
import type { CliRenderer } from '@opentui/core'
import { createOpenTuiKeymap } from '@opentui/keymap/opentui'
import type { TuiClientFacade } from '../client/context.js'
import type { TuiCommands } from '../contracts/commands.js'
import type { TuiSlots } from '../contracts/slots.js'
import type { TuiTheme } from '../contracts/theme.js'
import { createTuiCommands } from '../services/commands.js'
import { createTuiHost, type TuiHost } from '../services/host.js'
import { createTuiSlots } from '../services/slots.js'
import { createTuiTheme } from '../services/theme.js'
import { createNavigationStore, type TuiNavigationStore } from './navigation.js'
import { createTuiRenderer } from './renderer.js'

const TUI_CLIENT_ERROR = 'TUI client service unavailable'

export interface TuiKernel {
  readonly ready: true
  readonly resources: KernelResources
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly tuiHost: TuiHost
    readonly tuiKernel: TuiKernel
    readonly tuiTheme: TuiTheme
  }
}

export interface KernelResources {
  readonly commands: TuiCommands
  readonly navigation: TuiNavigationStore
  readonly renderer: CliRenderer
  readonly slots: TuiSlots
  readonly theme: TuiTheme
}

export interface KernelSeams {
  readonly createCommands: (renderer: CliRenderer) => TuiCommands
  readonly createNavigation: () => TuiNavigationStore
  readonly createRenderer: () => Promise<CliRenderer>
  readonly createSlots: (
    renderer: CliRenderer,
    client: TuiClientFacade,
    navigation: TuiNavigationStore,
    theme: TuiTheme,
  ) => TuiSlots
  readonly createTheme: () => TuiTheme
}

function isTuiClient(value: unknown): value is TuiClientFacade {
  return typeof value === 'object' && value !== null && 'api' in value && 'context' in value
}

function defaultSeams(): KernelSeams {
  return {
    createCommands: renderer => createTuiCommands(createOpenTuiKeymap(renderer)),
    createNavigation: createNavigationStore,
    createRenderer: createTuiRenderer,
    createSlots: (renderer, client, navigation, theme) => createTuiSlots(
      renderer,
      { client, navigation, theme },
    ),
    createTheme: () => createTuiTheme({ color: process.env.NO_COLOR === undefined }),
  }
}

export async function mountKernel(
  ctx: Context,
  seams: KernelSeams = defaultSeams(),
  clientOverride?: TuiClientFacade,
): Promise<KernelResources> {
  const client: unknown = clientOverride ?? ctx.get('tuiClient')
  if (!isTuiClient(client)) throw new Error(TUI_CLIENT_ERROR)

  const cleanup: Array<() => void | Promise<void>> = []
  try {
    const renderer = await seams.createRenderer()
    cleanup.push(() => { renderer.destroy() })
    const commands = seams.createCommands(renderer)
    cleanup.push(() => { commands.dispose() })
    const navigation = seams.createNavigation()
    const theme = seams.createTheme()
    const slots = seams.createSlots(renderer, client, navigation, theme)
    cleanup.push(() => { slots.dispose() })
    const host = createTuiHost(renderer, navigation)

    ctx.provide('tuiTheme', theme)
    ctx.provide('tuiCommands', commands)
    ctx.provide('tuiSlots', slots)
    ctx.provide('tuiHost', host)
    ctx.effect(() => async () => {
      for (const dispose of cleanup.toReversed()) await dispose()
    }, 'dsh-tui: kernel resources')

    return { commands, navigation, renderer, slots, theme }
  } catch (error) {
    for (const dispose of cleanup.toReversed()) await dispose()
    throw error
  }
}
