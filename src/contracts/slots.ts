import type { Context } from '@deepseek-ai/cordis'
import type {
  BaseRenderable,
  CoreManagedSlot,
  CoreSlotContribution,
  CoreSlotRegistry,
  CoreSlotRenderer,
  PluginErrorEvent,
} from '@opentui/core'
import type { TuiClientFacade } from '../client/context.js'
import type { TuiNavigationStore } from '../kernel/navigation.js'
import type { TuiTheme } from './theme.js'

export type TuiSlotId =
  | 'chrome'
  | 'footer'
  | 'overlay'
  | 'route'
  | 'route.chat'
  | 'route.inspect'
  | 'route.sessions'
  | 'route.settings'

export interface TuiSlotContext {
  readonly client: TuiClientFacade
  readonly navigation: TuiNavigationStore
  readonly theme: TuiTheme
}

export interface TuiSlotData {
  readonly focused: boolean
}

export type TuiSlotRenderer = CoreSlotRenderer<TuiSlotContext, TuiSlotData>
export type TuiManagedSlot = CoreManagedSlot<TuiSlotContext, TuiSlotData>

export interface TuiSlotContribution {
  readonly id: string
  readonly order?: number
  readonly slots: Partial<Record<TuiSlotId, CoreSlotContribution<TuiSlotContext, TuiSlotData>>>
}

export type TuiCoreSlotRegistry = CoreSlotRegistry<TuiSlotId, TuiSlotContext, TuiSlotData>

export interface TuiSlotRegistryAdapter {
  clear(): void
  register(contribution: TuiSlotContribution): () => void
}

export interface TuiSlots {
  readonly errors: readonly PluginErrorEvent[]
  readonly registry: TuiCoreSlotRegistry | undefined
  dispose(): void
  register(owner: Context, contribution: TuiSlotContribution): () => void
  subscribeErrors(owner: Context, listener: (error: PluginErrorEvent) => void): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly tuiSlots: TuiSlots
  }
}

export type TuiSlotNode = BaseRenderable
