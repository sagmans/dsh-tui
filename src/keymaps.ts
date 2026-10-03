/** Optional plugins own their actions; the terminal owns safe dispatch and key policy. */
import type { Context } from '@deepseek-ai/cordis'
import type { KeyId } from '@earendil-works/pi-tui'
import { ACTION_CATALOG, isPluginActionId, type Action } from './input/action-catalog.ts'
import { resolveKeymap, readKeys } from './input/actions.ts'
import { stripControlCharacters } from './text.ts'

export const name = 'tui-keymaps'
/** One public service identifier prevents composition from drifting from addon discovery. */
export const TUI_KEYMAP_SERVICE = 'tuiKeymaps'
const UNAVAILABLE = 'plugin key action is unavailable'
const INVALID_ACTION = 'plugin key action requires a namespaced id, a printable label, and chord or surface keys'
const DUPLICATE = 'duplicate plugin key action'

/** Row data avoids coupling a plugin to the terminal library or an internal picker class. */
export interface PickerRow { readonly id: string; readonly name: string; readonly description?: string; readonly current?: boolean }
/** Route facts belong to the invocation, never a cached plugin registration. */
export interface ActionPorts {
  readonly route: { readonly provider: string; readonly model: string } | undefined
  readonly pick: (spec: { readonly title: string; readonly rows: readonly PickerRow[] }) => Promise<string | undefined>
  readonly notice: (message: string) => void
}
/** Plugins cannot register keys inside approval gates, questions, or library-owned editors. */
export interface PluginAction {
  readonly id: string
  readonly layer: 'chord' | 'surface'
  readonly defaultKeys: readonly KeyId[]
  readonly label: string
  readonly handler: (ports: ActionPorts) => Promise<void>
  /** Route-specific qualifiers share the action owner rather than leaking provider policy into the footer. */
  readonly routeHint?: (route: NonNullable<ActionPorts['route']>) => string | undefined
}
/** One host's registry keeps optional plugins independent of other terminal instances. */
export interface KeymapRegistry {
  register(owner: Context, action: PluginAction): () => void
  afterEffort(owner: Context, handler: (ports: ActionPorts) => Promise<void>): () => void
  catalog(): readonly Action[]
  routeHints(route: NonNullable<ActionPorts['route']>): readonly string[]
  dispatch(id: string, ports: ActionPorts): Promise<void>
  effortConfirmed(ports: ActionPorts): Promise<void>
  observe(validate: (catalog: readonly Action[]) => void, changed: () => void): () => void
}
declare module '@deepseek-ai/cordis' { interface Context { tuiKeymaps: KeymapRegistry } }

/** Validate before publication so a rejected registration cannot corrupt the active keyboard. */
export function createKeymapRegistry(): KeymapRegistry {
  const registrations = new Map<string, PluginAction>()
  const followups = new Set<{ readonly handler: (ports: ActionPorts) => Promise<void> }>()
  const observers = new Set<{ validate: (catalog: readonly Action[]) => void; changed: () => void }>()
  const catalog = (rows: ReadonlyMap<string, PluginAction> = registrations): readonly Action[] => [
    ...ACTION_CATALOG,
    ...[...rows.values()].map(row => ({ id: row.id, layer: row.layer, defaultKeys: row.defaultKeys, label: row.label,
      mayUseBare: row.layer === 'chord', mayUnbind: true })),
  ]
  const publish = (rows: ReadonlyMap<string, PluginAction>): void => {
    const actions = catalog(rows)
    if (observers.size === 0) resolveKeymap({}, actions)
    for (const observer of observers) observer.validate(actions)
    registrations.clear()
    for (const [id, row] of rows) registrations.set(id, row)
    for (const observer of observers) observer.changed()
  }
  return {
    catalog,
    routeHints: route => {
      const hints: string[] = []
      for (const action of [...registrations.values()]) {
        if (registrations.get(action.id) !== action) continue
        try {
          const hint = action.routeHint?.(route)
          if (typeof hint === 'string' && hint.trim() && stripControlCharacters(hint) === hint) hints.push(hint.trim())
        } catch {
          // An optional addon cannot break a repaint or expose private failure details.
        }
      }
      return hints
    },
    register: (owner, action) => {
      if (!isPluginActionId(action.id) || !action.label.trim() || stripControlCharacters(action.label) !== action.label
        || !['chord', 'surface'].includes(action.layer) || typeof action.handler !== 'function'
        || (action.routeHint !== undefined && typeof action.routeHint !== 'function')) throw new Error(INVALID_ACTION)
      if (registrations.has(action.id)) throw new Error(DUPLICATE)
      const defaults = readKeys({ ...action, defaultKeys: [], mayUseBare: action.layer === 'chord', mayUnbind: true }, action.defaultKeys)
      const row = Object.freeze({ ...action, defaultKeys: Object.freeze([...defaults]) })
      const next = new Map(registrations).set(row.id, row)
      // Validate synchronously even when an owner defers effect installation.
      const actions = catalog(next)
      if (observers.size === 0) resolveKeymap({}, actions)
      for (const observer of observers) observer.validate(actions)
      return owner.effect(() => {
        if (registrations.has(row.id)) throw new Error(DUPLICATE)
        publish(new Map(registrations).set(row.id, row))
        return () => {
          if (registrations.get(row.id) !== row) return
          const remaining = new Map(registrations)
          remaining.delete(row.id)
          publish(remaining)
        }
      })
    },
    afterEffort: (owner, handler) => owner.effect(() => {
      // Callable identity cannot stand in for ownership when two plugins share a helper.
      const registration = { handler }
      followups.add(registration)
      return () => { followups.delete(registration) }
    }),
    dispatch: async (id, ports) => {
      const action = registrations.get(id)
      if (action === undefined) throw new Error(UNAVAILABLE)
      await action.handler(ports)
    },
    // Addons can offer route-specific UI after effort selection without entering the built-in action table.
    // Await each followup before another picker opens; earlier callbacks may dispose later registrations.
    effortConfirmed: async ports => {
      for (const registration of [...followups]) if (followups.has(registration)) await registration.handler(ports)
    },
    observe: (validate, changed) => {
      validate(catalog())
      const observer = { validate, changed }
      observers.add(observer)
      return () => { observers.delete(observer) }
    },
  }
}

/** Early publication lets addons register before the terminal composes its effective keymap. */
export function apply(ctx: Context): void { ctx.provide(TUI_KEYMAP_SERVICE, createKeymapRegistry()) }
