import type { Context } from '@deepseek-ai/cordis'
import type { KeyEvent, Renderable } from '@opentui/core'
import { stringifyKeySequence, type Binding, type Command, type Keymap, type Layer } from '@opentui/keymap'
import {
  registerDeadBindingWarnings,
  registerDefaultKeys,
  registerEnabledFields,
  registerLeader,
  registerMetadataFields,
  registerUnresolvedCommandWarnings,
} from '@opentui/keymap/addons'
import { getGraphSnapshot } from '@opentui/keymap/extras/graph'
import type {
  TuiCommandConflict,
  TuiCommandLayer,
  TuiCommandQuery,
  TuiCommands,
  TuiCommandView,
  TuiKeymap,
} from '../contracts/commands.js'

const DESCRIPTION_ATTRIBUTE = 'desc'
const DISPOSED_SERVICE_ERROR = 'TUI command service disposed'
const LEADER_KEY = 'space'

function commandDefinitions(layer: TuiCommandLayer): readonly Command<Renderable, KeyEvent>[] {
  return layer.commands.map(command => ({
    name: command.name,
    run: command.run,
    [DESCRIPTION_ATTRIBUTE]: command.description,
  }))
}

function bindingDefinitions(layer: TuiCommandLayer): readonly Binding<Renderable, KeyEvent>[] {
  return layer.bindings.map(binding => ({ key: binding.key, cmd: binding.command }))
}

function keymapLayer(layer: TuiCommandLayer): Layer<Renderable, KeyEvent> {
  return {
    ...layer.active === undefined ? {} : { enabled: layer.active },
    bindings: bindingDefinitions(layer),
    commands: commandDefinitions(layer),
    ...layer.priority === undefined ? {} : { priority: layer.priority },
    ...layer.target === undefined ? {} : { target: layer.target },
    ...layer.targetMode === undefined ? {} : { targetMode: layer.targetMode },
  }
}

class CommandService implements TuiCommands {
  readonly keymap: TuiKeymap
  private readonly layers = new Map<string, () => void>()
  private readonly listeners = new Set<() => void>()
  private readonly resources: Array<() => void>
  private disposed = false

  constructor(keymap: TuiKeymap) {
    this.keymap = keymap
    this.resources = [
      registerDefaultKeys(keymap),
      registerEnabledFields(keymap),
      registerLeader(keymap, { trigger: LEADER_KEY }),
      registerMetadataFields(keymap),
      registerDeadBindingWarnings(keymap),
      registerUnresolvedCommandWarnings(keymap),
      keymap.on('state', () => {
        for (const listener of this.listeners) listener()
      }),
    ]
  }

  conflicts(): readonly TuiCommandConflict[] {
    return getGraphSnapshot(this.keymap, { includeTargets: false }).bindings
      .filter(binding => binding.shadowed)
      .map(binding => ({
        command: typeof binding.command === 'string' ? binding.command : undefined,
        key: stringifyKeySequence(binding.sequence, { preferDisplay: true, separator: ' ' }),
        reason: 'shadowed' as const,
      }))
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const dispose of [...this.layers.values()].toReversed()) dispose()
    this.layers.clear()
    for (const dispose of this.resources.toReversed()) dispose()
    this.listeners.clear()
  }

  list(query: TuiCommandQuery = {}): readonly TuiCommandView[] {
    return this.keymap.getCommandEntries({
      visibility: query.visibility ?? 'active',
      ...query.search === undefined ? {} : { search: query.search },
    }).map(entry => {
      const description = entry.command[DESCRIPTION_ATTRIBUTE]
      return {
        name: entry.command.name,
        description: typeof description === 'string' ? description : entry.command.name,
        bindings: entry.bindings.map(binding => stringifyKeySequence(
          binding.sequence,
          { preferDisplay: true, separator: ' ' },
        )),
      }
    })
  }

  register(owner: Context, layer: TuiCommandLayer): () => void {
    if (this.disposed) throw new Error(DISPOSED_SERVICE_ERROR)
    if (this.layers.has(layer.id)) throw new Error(`duplicate TUI command layer: ${layer.id}`)
    let active = true
    const unregister = this.keymap.registerLayer(keymapLayer(layer))
    const release = (): void => {
      if (!active) return
      active = false
      this.layers.delete(layer.id)
      unregister()
    }
    let disposeEffect: () => Promise<void>
    try {
      disposeEffect = owner.effect(() => release, `tuiCommands.register(${JSON.stringify(layer.id)})`)
    } catch (error) {
      release()
      throw error
    }
    const dispose = (): void => { void disposeEffect() }
    this.layers.set(layer.id, dispose)
    return dispose
  }

  run(command: string): ReturnType<Keymap<Renderable, KeyEvent>['runCommand']> {
    return this.keymap.runCommand(command)
  }

  subscribe(owner: Context, listener: () => void): () => void {
    if (this.disposed) throw new Error(DISPOSED_SERVICE_ERROR)
    this.listeners.add(listener)
    const release = (): void => { this.listeners.delete(listener) }
    let disposeEffect: () => Promise<void>
    try {
      disposeEffect = owner.effect(() => release, 'tuiCommands.subscribe')
    } catch (error) {
      release()
      throw error
    }
    return () => { void disposeEffect() }
  }
}

export function createTuiCommands(keymap: TuiKeymap): TuiCommands {
  return new CommandService(keymap)
}
