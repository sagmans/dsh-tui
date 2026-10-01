/** Generic invocation keeps addon UI behavior outside the terminal's built-in action table. */
import type { Context } from '@deepseek-ai/cordis'
import type { Keymap } from '../input/actions.ts'
import { TUI_KEYMAP_SERVICE, type ActionPorts, type KeymapRegistry } from '../keymaps.ts'
import { stripControlCharacters } from '../text.ts'
import { EffortPicker } from '../ui/picker.ts'
import type { StatusFacts } from '../ui/status.ts'
import type { Picker } from './modal-input.ts'

const FAILED = 'plugin action could not complete; check plugin configuration and retry'

/** The modal owner and current route remain authoritative for every plugin invocation. */
export function createPluginActions(ctx: Context, ports: {
  statusFacts(): StatusFacts
  keymap(): Keymap
  openPicker(picker: Picker): Promise<string | undefined>
  notice(message: string): void
  render(): void
}) {
  let opening = false
  const invoke = async (id: string | undefined, route: ActionPorts['route']): Promise<void> => {
    if (opening) return
    opening = true
    try {
      const registry = ctx.get(TUI_KEYMAP_SERVICE) as KeymapRegistry | undefined
      if (registry === undefined) throw new Error(FAILED)
      const surface: ActionPorts = { route, notice: ports.notice, pick: async spec => {
        const rows = spec.rows.map(row => ({ ...row, name: stripControlCharacters(row.name),
          description: stripControlCharacters(row.description ?? ''), current: row.current ?? false }))
        return await ports.openPicker(new EffortPicker(() => rows, stripControlCharacters(spec.title), ports.keymap))
      } }
      if (id === undefined) await registry.effortConfirmed(surface)
      else await registry.dispatch(id, surface)
    } catch { ports.notice(FAILED) }
    finally { opening = false; ports.render() }
  }
  return {
    run: async (id: string): Promise<void> => {
      const facts = ports.statusFacts()
      await invoke(id, facts.provider !== undefined && facts.model !== undefined ? { provider: facts.provider, model: facts.model } : undefined)
    },
    afterEffort: async (route: NonNullable<ActionPorts['route']>): Promise<void> => {
      if (ctx.get(TUI_KEYMAP_SERVICE) !== undefined) await invoke(undefined, route)
    },
  }
}
