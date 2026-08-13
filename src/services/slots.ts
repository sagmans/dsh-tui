import type { Context } from '@deepseek-ai/cordis'
import {
  createCoreSlotRegistry,
  registerCorePlugin,
  type CliRenderer,
  type PluginErrorEvent,
  type SlotRegistryOptions,
} from '@opentui/core'
import type {
  TuiCoreSlotRegistry,
  TuiSlotContext,
  TuiSlotContribution,
  TuiSlotData,
  TuiSlotRegistryAdapter,
  TuiSlots,
} from '../contracts/slots.js'

const DUPLICATE_CONTRIBUTION_ERROR = 'duplicate TUI slot contribution'
const DISPOSED_SERVICE_ERROR = 'TUI slot service disposed'
const DEFAULT_MAX_PLUGIN_ERRORS = 32

export interface TuiSlotsOptions {
  readonly maxPluginErrors?: number
}

function createCoreAdapter(
  renderer: CliRenderer,
  context: TuiSlotContext,
  options: SlotRegistryOptions,
): { readonly adapter: TuiSlotRegistryAdapter; readonly registry: TuiCoreSlotRegistry } {
  const registry = createCoreSlotRegistry<string, TuiSlotContext, TuiSlotData>(
    renderer,
    context,
    options,
  )
  return {
    registry,
    adapter: {
      clear: () => { registry.clear() },
      register: contribution => registerCorePlugin(registry, contribution),
    },
  }
}

class SlotService implements TuiSlots {
  readonly registry: TuiCoreSlotRegistry | undefined
  private readonly adapter: TuiSlotRegistryAdapter
  private readonly errorListeners = new Set<(error: PluginErrorEvent) => void>()
  private readonly pluginErrors: PluginErrorEvent[] = []
  private readonly registrations = new Map<string, () => void>()
  private disposed = false

  constructor(adapter: TuiSlotRegistryAdapter, registry?: TuiCoreSlotRegistry) {
    this.adapter = adapter
    this.registry = registry
  }

  get errors(): readonly PluginErrorEvent[] {
    return this.registry?.getPluginErrors() ?? this.pluginErrors
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const dispose of [...this.registrations.values()].toReversed()) dispose()
    this.registrations.clear()
    this.adapter.clear()
    this.errorListeners.clear()
  }

  register(owner: Context, contribution: TuiSlotContribution): () => void {
    if (this.disposed) throw new Error(DISPOSED_SERVICE_ERROR)
    if (this.registrations.has(contribution.id)) {
      throw new Error(`${DUPLICATE_CONTRIBUTION_ERROR}: ${contribution.id}`)
    }
    let active = true
    const unregister = this.adapter.register(contribution)
    const release = (): void => {
      if (!active) return
      active = false
      this.registrations.delete(contribution.id)
      unregister()
    }
    let disposeEffect: () => Promise<void>
    try {
      disposeEffect = owner.effect(() => release, `tuiSlots.register(${JSON.stringify(contribution.id)})`)
    } catch (error) {
      release()
      throw error
    }
    const dispose = (): void => { void disposeEffect() }
    this.registrations.set(contribution.id, dispose)
    return dispose
  }

  subscribeErrors(owner: Context, listener: (error: PluginErrorEvent) => void): () => void {
    if (this.disposed) throw new Error(DISPOSED_SERVICE_ERROR)
    this.errorListeners.add(listener)
    const unsubscribe = (): void => { this.errorListeners.delete(listener) }
    let disposeEffect: () => Promise<void>
    try {
      disposeEffect = owner.effect(() => unsubscribe, 'tuiSlots.subscribeErrors()')
    } catch (error) {
      unsubscribe()
      throw error
    }
    return () => { void disposeEffect() }
  }

  report(error: PluginErrorEvent): void {
    this.pluginErrors.push(error)
    for (const listener of this.errorListeners) listener(error)
  }
}

export function createTuiSlots(adapter: TuiSlotRegistryAdapter): TuiSlots
export function createTuiSlots(
  renderer: CliRenderer,
  context: TuiSlotContext,
  options?: TuiSlotsOptions,
): TuiSlots
export function createTuiSlots(
  rendererOrAdapter: CliRenderer | TuiSlotRegistryAdapter,
  context?: TuiSlotContext,
  options: TuiSlotsOptions = {},
): TuiSlots {
  if ('register' in rendererOrAdapter && 'clear' in rendererOrAdapter) {
    return new SlotService(rendererOrAdapter)
  }
  if (context === undefined) throw new Error('TUI slot context is required')
  const reportTarget: { service: SlotService | null } = { service: null }
  const core = createCoreAdapter(rendererOrAdapter, context, {
    maxPluginErrors: options.maxPluginErrors ?? DEFAULT_MAX_PLUGIN_ERRORS,
    onPluginError: error => { reportTarget.service?.report(error) },
  })
  const service = new SlotService(core.adapter, core.registry)
  reportTarget.service = service
  return service
}
