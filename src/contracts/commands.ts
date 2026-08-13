import type { Context } from '@deepseek-ai/cordis'
import type { KeyEvent, Renderable } from '@opentui/core'
import type { CommandContext, Keymap, RunCommandResult, TargetMode } from '@opentui/keymap'

export type TuiKeymap = Keymap<Renderable, KeyEvent>

export interface TuiCommand {
  readonly description: string
  readonly name: string
  readonly run: (context: CommandContext<Renderable, KeyEvent>) => void | Promise<void>
}

export interface TuiCommandBinding {
  readonly command: string
  readonly key: string
}

export interface TuiCommandLayer {
  readonly bindings: readonly TuiCommandBinding[]
  readonly commands: readonly TuiCommand[]
  readonly id: string
  readonly priority?: number
  readonly target?: Renderable
  readonly targetMode?: TargetMode
}

export interface TuiCommandView {
  readonly bindings: readonly string[]
  readonly description: string
  readonly name: string
}

export interface TuiCommandConflict {
  readonly command: string | undefined
  readonly key: string
  readonly reason: 'shadowed'
}

export interface TuiCommandQuery {
  readonly search?: string
  readonly visibility?: 'active' | 'reachable' | 'registered'
}

export interface TuiCommands {
  readonly keymap: TuiKeymap
  conflicts(): readonly TuiCommandConflict[]
  dispose(): void
  list(query?: TuiCommandQuery): readonly TuiCommandView[]
  register(owner: Context, layer: TuiCommandLayer): () => void
  run(command: string): RunCommandResult<Renderable, KeyEvent>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly tuiCommands: TuiCommands
  }
}
