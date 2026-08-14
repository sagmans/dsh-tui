import type { Context } from '@deepseek-ai/cordis'
import type { TuiCommandLayer } from '../../contracts/commands.js'
import type { KernelResources } from '../../kernel/lifecycle.js'
import {
  createShellController,
  DEFAULT_SHELL_BINDINGS,
  shellCommandDescription,
  type ShellBindings,
  type ShellCommandName,
} from './model.js'
import { mountShellView, type ShellView, type ShellViewOptions } from '../../views/shell/root.js'

const SHELL_COMMAND_LAYER_ID = 'dsh-tui-shell'
const PALETTE_COMMAND_LAYER_ID = 'dsh-tui-shell-palette'
const SHELL_COMMAND_PRIORITY = 100
const PALETTE_COMMAND_PRIORITY = 200
const INVALID_CONFIG_ERROR = 'invalid TUI shell config'
const BINDING_KEYS = Object.freeze([
  'accept',
  'escape',
  'help',
  'next',
  'nextAlternate',
  'palette',
  'previous',
  'previousAlternate',
  'quit',
  'routeChat',
  'routeInspect',
  'routeSessions',
  'routeSettings',
  'zen',
] as const satisfies readonly (keyof ShellBindings)[])

export interface Config {
  readonly bindings?: Partial<ShellBindings>
}

interface ResolvedConfig {
  readonly bindings: ShellBindings
}

interface ConfigIssue {
  readonly message: string
}

type ConfigValidation =
  | { readonly value: ResolvedConfig; readonly issues?: never }
  | { readonly issues: readonly ConfigIssue[]; readonly value?: never }

type MutableShellBindings = { -readonly [Key in keyof ShellBindings]: ShellBindings[Key] }

export const DEFAULT_SHELL_CONFIG: Readonly<ResolvedConfig> = Object.freeze({
  bindings: DEFAULT_SHELL_BINDINGS,
})

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateConfig(value: unknown): ConfigValidation {
  if (value === undefined) return { value: DEFAULT_SHELL_CONFIG }
  if (!isRecord(value)) return { issues: [{ message: 'shell config must be an object' }] }
  const configuredBindings = value.bindings
  if (configuredBindings === undefined) return { value: DEFAULT_SHELL_CONFIG }
  if (!isRecord(configuredBindings)) return { issues: [{ message: 'bindings must be an object' }] }

  const bindings: MutableShellBindings = { ...DEFAULT_SHELL_BINDINGS }
  const issues: ConfigIssue[] = []
  for (const key of BINDING_KEYS) {
    const configured = configuredBindings[key]
    if (configured === undefined) continue
    if (typeof configured !== 'string' || configured.trim().length === 0) {
      issues.push({ message: `binding ${key} must be a non-empty string` })
      continue
    }
    bindings[key] = configured
  }
  if (issues.length > 0) return { issues }
  return { value: Object.freeze({ bindings: Object.freeze(bindings) }) }
}

export const Config = {
  '~standard': {
    version: 1,
    vendor: '@sagmans/dsh-tui',
    validate: validateConfig,
  },
} as const

export const name = 'tui-shell'
export const inject: readonly string[] = ['tuiKernel', 'tuiClient']

const COMMAND_BINDING_KEYS: Readonly<Record<ShellCommandName, readonly (keyof ShellBindings)[]>> = Object.freeze({
  'palette.next': ['next', 'nextAlternate'],
  'palette.previous': ['previous', 'previousAlternate'],
  'palette.run': ['accept'],
  'route.chat': ['routeChat'],
  'route.inspect': ['routeInspect'],
  'route.sessions': ['routeSessions'],
  'route.settings': ['routeSettings'],
  'session.next': ['next', 'nextAlternate'],
  'session.previous': ['previous', 'previousAlternate'],
  'shell.escape': ['escape'],
  'shell.help': ['help'],
  'shell.palette': ['palette'],
  'shell.quit': ['quit'],
  'shell.zen': ['zen'],
})

const ACTION_COMMANDS: readonly ShellCommandName[] = [
  'palette.next',
  'palette.previous',
  'palette.run',
  'route.chat',
  'route.sessions',
  'route.inspect',
  'route.settings',
  'session.next',
  'session.previous',
  'shell.palette',
  'shell.help',
  'shell.zen',
  'shell.escape',
  'shell.quit',
]

function shellCommands(
  ctx: Context,
  resources: KernelResources,
  config: ResolvedConfig,
): {
  readonly controller: ReturnType<typeof createShellController>
  readonly layers: readonly TuiCommandLayer[]
} {
  const controller = createShellController({
    bindings: config.bindings,
    navigation: resources.navigation,
    onQuit: () => { resources.renderer.destroy() },
    sessions: {
      getSnapshot: () => ctx.tuiClient.sessions.list.getSnapshot(),
      subscribe: listener => ctx.tuiClient.sessions.list.subscribe(listener),
      open: id => { ctx.tuiClient.sessions.open(id) },
      clear: () => { ctx.tuiClient.sessions.clear() },
    },
  })
  const command = (commandName: ShellCommandName): TuiCommandLayer['commands'][number] => ({
    name: commandName,
    description: shellCommandDescription(commandName, resources.locale),
    run: () => { controller.run(commandName) },
  })
  const globalCommands = ACTION_COMMANDS.filter(commandName => !commandName.startsWith('palette.'))
  const globalBindings = Object.entries(COMMAND_BINDING_KEYS)
    .filter(([commandName]) => !commandName.startsWith('palette.'))
    .flatMap(([commandName, keys]) => {
      return keys.map(key => ({ command: commandName, key: config.bindings[key] }))
    })
  const paletteCommands = ACTION_COMMANDS.filter(commandName => commandName.startsWith('palette.'))
  const paletteBindings = Object.entries(COMMAND_BINDING_KEYS)
    .filter(([commandName]) => commandName.startsWith('palette.'))
    .flatMap(([commandName, keys]) => {
      return keys.map(key => ({ command: commandName, key: config.bindings[key] }))
    })
  const globalLayer: TuiCommandLayer = {
    id: SHELL_COMMAND_LAYER_ID, priority: SHELL_COMMAND_PRIORITY,
    active: () => controller.getSnapshot().overlay === undefined
      && (resources.renderer.currentFocusedEditor === null
        || resources.renderer.currentFocusedEditor === undefined),
    commands: globalCommands.map(commandName => command(commandName)),
    bindings: globalBindings,
  }
  const paletteLayer: TuiCommandLayer = {
    id: PALETTE_COMMAND_LAYER_ID, priority: PALETTE_COMMAND_PRIORITY,
    active: () => controller.getSnapshot().overlay === 'palette',
    commands: paletteCommands.map(commandName => command(commandName)),
    bindings: paletteBindings,
  }
  return {
    controller,
    layers: [globalLayer, paletteLayer],
  }
}

export interface ShellSeams {
  readonly mountView: (options: ShellViewOptions) => ShellView
}

const DEFAULT_SHELL_SEAMS: ShellSeams = {
  mountView: mountShellView,
}

export function mountShell(
  ctx: Context,
  config: Config = DEFAULT_SHELL_CONFIG,
  seams: ShellSeams = DEFAULT_SHELL_SEAMS,
): void {
  const validation = validateConfig(config)
  if (validation.issues !== undefined) {
    throw new Error(`${INVALID_CONFIG_ERROR}: ${validation.issues.map(issue => issue.message).join(', ')}`)
  }
  const resources = ctx.tuiKernel.resources
  const { controller, layers } = shellCommands(ctx, resources, validation.value)
  const disposeCommands = layers.map(layer => resources.commands.register(ctx, layer))
  let view: ShellView | undefined
  try {
    view = seams.mountView({
      controller,
      locale: resources.locale,
      renderer: resources.renderer,
      slots: resources.slots,
      theme: resources.theme,
    })
    resources.renderer.root.add(view.root)
    ctx.effect(() => () => {
      view?.dispose()
      controller.dispose()
    }, 'dsh-tui: shell view')
  } catch (error) {
    view?.dispose()
    controller.dispose()
    for (const dispose of disposeCommands.toReversed()) dispose()
    throw error
  }
}

export function apply(ctx: Context, config: Config = DEFAULT_SHELL_CONFIG): void {
  mountShell(ctx, config)
}
