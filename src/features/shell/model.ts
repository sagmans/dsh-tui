import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { ObservableSnapshot, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { TuiNavigationStore, TuiRoute } from '../../kernel/navigation.js'

export type ShellOverlay = string
export type PaletteCommandName =
  | 'route.chat'
  | 'route.inspect'
  | 'route.sessions'
  | 'route.settings'
  | 'shell.help'
  | 'shell.quit'
  | 'shell.zen'

export type ShellActionCommandName =
  | PaletteCommandName
  | 'session.next'
  | 'session.previous'
  | 'palette.next'
  | 'palette.previous'
  | 'palette.run'
  | 'shell.escape'
  | 'shell.palette'

export type ShellCommandName = ShellActionCommandName

export interface ShellBindings {
  readonly accept: string
  readonly escape: string
  readonly help: string
  readonly next: string
  readonly nextAlternate: string
  readonly palette: string
  readonly previous: string
  readonly previousAlternate: string
  readonly quit: string
  readonly routeChat: string
  readonly routeInspect: string
  readonly routeSessions: string
  readonly routeSettings: string
  readonly zen: string
}

export interface ShellSnapshot {
  readonly activeSessionRunning: boolean
  readonly activeSessionTitle: string | undefined
  readonly overlay: ShellOverlay | undefined
  readonly paletteCommand: PaletteCommandName
  readonly route: TuiRoute
  readonly sessionCount: number
  readonly zen: boolean
}

export interface ShellSessionSource extends ObservableSnapshot<SessionListState> {
  clear(): void
  open(id: SessionId): void
}

export interface ShellController {
  readonly bindings: ShellBindings
  dispose(): void
  getSnapshot(): ShellSnapshot
  openRoute(route: TuiRoute): void
  openSession(id: SessionId): void
  run(command: ShellActionCommandName): void
  subscribe(listener: () => void): () => void
}

const HELP_OVERLAY_ID: ShellOverlay = 'help'
const PALETTE_OVERLAY_ID: ShellOverlay = 'palette'

export const PALETTE_COMMANDS = Object.freeze([
  'route.chat',
  'route.sessions',
  'route.inspect',
  'route.settings',
  'shell.help',
  'shell.zen',
  'shell.quit',
] as const satisfies readonly PaletteCommandName[])

export const DEFAULT_SHELL_BINDINGS: Readonly<ShellBindings> = Object.freeze({
  accept: 'return',
  escape: 'escape',
  help: '?',
  next: 'j',
  nextAlternate: 'ctrl+n',
  palette: '<leader>p',
  previous: 'k',
  previousAlternate: 'ctrl+p',
  quit: 'q',
  routeChat: 'gc',
  routeInspect: 'gi',
  routeSessions: 'gs',
  routeSettings: 'g,',
  zen: 'z',
})

export const SHELL_COMMAND_DESCRIPTIONS: Readonly<Record<ShellCommandName, string>> = Object.freeze({
  'palette.next': 'Select next palette command',
  'palette.previous': 'Select previous palette command',
  'palette.run': 'Run selected palette command',
  'route.chat': 'Open chat',
  'route.inspect': 'Open inspector',
  'route.sessions': 'Open sessions',
  'route.settings': 'Open settings',
  'session.next': 'Open next session',
  'session.previous': 'Open previous session',
  'shell.escape': 'Close overlay or return to chat',
  'shell.help': 'Toggle key help',
  'shell.palette': 'Toggle command palette',
  'shell.quit': 'Exit terminal interface',
  'shell.zen': 'Toggle zen mode',
})

class ShellControllerService implements ShellController {
  readonly bindings: ShellBindings
  private readonly listeners = new Set<() => void>()
  private readonly navigation: TuiNavigationStore
  private readonly onQuit: () => void
  private readonly sessions: ShellSessionSource
  private readonly resources: Array<() => void>
  private paletteIndex = 0
  private zen = true

  constructor(
    navigation: TuiNavigationStore,
    sessions: ShellSessionSource,
    bindings: ShellBindings,
    onQuit: () => void,
  ) {
    this.navigation = navigation
    this.onQuit = onQuit
    this.sessions = sessions
    this.bindings = Object.freeze({ ...bindings })
    this.resources = [
      navigation.subscribe(() => { this.publish() }),
      sessions.subscribe(() => { this.publish() }),
    ]
  }

  dispose(): void {
    for (const dispose of this.resources.splice(0).toReversed()) dispose()
    this.listeners.clear()
  }

  getSnapshot(): ShellSnapshot {
    const navigation = this.navigation.getSnapshot()
    const sessions = this.sessions.getSnapshot()
    const current = sessions.current === undefined ? undefined : sessions.byId[sessions.current]
    const overlay = navigation.overlays.at(-1)?.id

    return Object.freeze({
      activeSessionRunning: current?.running ?? false,
      activeSessionTitle: current?.displayTitle,
      route: navigation.route,
      sessionCount: sessions.ids.length,
      overlay,
      paletteCommand: PALETTE_COMMANDS[this.paletteIndex] ?? PALETTE_COMMANDS[0],
      zen: this.zen,
    })
  }

  openRoute(route: TuiRoute): void {
    this.navigation.go(route)
  }

  openSession(id: SessionId): void {
    this.sessions.open(id)
  }

  run(command: ShellActionCommandName): void {
    switch (command) {
      case 'route.chat': this.openRoute('chat'); break
      case 'route.inspect': this.openRoute('inspect'); break
      case 'route.sessions': this.openRoute('sessions'); break
      case 'route.settings': this.openRoute('settings'); break
      case 'session.next':
        this.moveSession(1)
        break
      case 'session.previous':
        this.moveSession(-1)
        break
      case 'palette.next':
        this.movePalette(1)
        break
      case 'palette.previous':
        this.movePalette(-1)
        break
      case 'palette.run':
        this.runPaletteCommand()
        break
      case 'shell.escape':
        if (this.navigation.closeOverlay() === undefined) this.openRoute('chat')
        break
      case 'shell.help':
        this.toggleOverlay(HELP_OVERLAY_ID)
        break
      case 'shell.palette':
        this.toggleOverlay(PALETTE_OVERLAY_ID)
        break
      case 'shell.quit':
        this.onQuit()
        break
      case 'shell.zen':
        this.zen = !this.zen
        this.publish()
        break
      default: {
        const exhaustive: never = command
        throw new Error(`unhandled shell command: ${String(exhaustive)}`)
      }
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private movePalette(offset: number): void {
    if (this.getSnapshot().overlay !== PALETTE_OVERLAY_ID) return
    this.paletteIndex = (this.paletteIndex + offset + PALETTE_COMMANDS.length) % PALETTE_COMMANDS.length
    this.publish()
  }

  private moveSession(offset: number): void {
    const state = this.sessions.getSnapshot()
    if (state.ids.length === 0) return
    const currentIndex = state.current === undefined ? -1 : state.ids.indexOf(state.current)
    const startIndex = Math.max(0, currentIndex)
    const nextIndex = (startIndex + offset + state.ids.length) % state.ids.length
    const next = state.ids[nextIndex]
    if (next !== undefined) this.openSession(next)
  }

  private runPaletteCommand(): void {
    if (this.getSnapshot().overlay !== PALETTE_OVERLAY_ID) return
    const command = PALETTE_COMMANDS[this.paletteIndex]
    if (command === undefined) return
    this.navigation.closeOverlay()
    this.run(command)
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
  }

  private toggleOverlay(id: ShellOverlay): void {
    const current = this.navigation.getSnapshot().overlays.at(-1)
    if (current?.id === id) {
      this.navigation.closeOverlay()
      return
    }
    if (id === PALETTE_OVERLAY_ID) this.paletteIndex = 0
    this.navigation.openOverlay({ id })
  }
}

export interface ShellControllerOptions {
  readonly bindings?: ShellBindings
  readonly navigation: TuiNavigationStore
  readonly onQuit?: () => void
  readonly sessions: ShellSessionSource
}

export function createShellController(options: ShellControllerOptions): ShellController {
  return new ShellControllerService(
    options.navigation,
    options.sessions,
    options.bindings ?? DEFAULT_SHELL_BINDINGS,
    options.onQuit ?? (() => {}),
  )
}
