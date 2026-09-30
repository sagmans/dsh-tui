/** Discover paid processing policy from its owner rather than guessing from provider names. */
import type { Context } from '@deepseek-ai/cordis'
import type { Keymap } from '../input/actions.ts'
import { EffortPicker } from '../ui/picker.ts'
import type { Picker } from './modal-input.ts'

const SERVICE_NAME = 'providerServiceTiers'
const PROVIDER_DEFAULT_TIER_ID = ''
const SAVE_FAILURE = 'could not save service tier; check writable provider settings and retry'
const DISCOVERY_FAILURE = 'could not read service tiers; check provider configuration and retry'

interface TierOwner {
  choices(provider: string, model: string): readonly { id: string; name: string; description?: string }[]
  current(provider: string, model: string): string | undefined
  select(provider: string, model: string, tier: string | undefined): Promise<void>
}
interface TierPickerPorts {
  keymap: () => Keymap
  openPicker(picker: Picker): Promise<string | undefined>
  notice(message: string): void
  render(): void
}

/** Resolve the owner per opening because saving Config may replace the provider plugin. */
export function createServiceTierPicker(ctx: Context, ports: TierPickerPorts): (
  route: { provider: string; model: string } | undefined, quiet?: boolean,
) => Promise<void> {
  let opening = false
  return async (route, quiet = false) => {
    if (opening) return
    opening = true
    let saving = false
    try {
      if (route === undefined) {
        if (!quiet) ports.notice('no model route is in use; choose a model first')
        return
      }
      const owner = (ctx as unknown as { get(name: string): unknown }).get(SERVICE_NAME) as Partial<TierOwner> | undefined
      if (typeof owner?.choices !== 'function' || typeof owner.current !== 'function' || typeof owner.select !== 'function') {
        if (!quiet) ports.notice('no service tier provider is mounted; configure dsh-provider-extra first')
        return
      }
      const choices = owner.choices(route.provider, route.model)
      if (choices.length === 0) {
        if (!quiet) ports.notice('this model route advertises no service tiers')
        return
      }
      const current = owner.current(route.provider, route.model)
      const rows = [
        { id: PROVIDER_DEFAULT_TIER_ID, name: 'provider default', description: 'clear the explicit service tier', current: current === undefined },
        ...choices.map(choice => ({ ...choice, current: choice.id === current })),
      ]
      const picked = await ports.openPicker(new EffortPicker(() => rows, 'service tier · ' + route.provider + '/' + route.model, ports.keymap))
      if (picked === undefined) return
      if (!rows.some(row => row.id === picked)) throw new Error(DISCOVERY_FAILURE)
      saving = true
      await owner.select(route.provider, route.model, picked === PROVIDER_DEFAULT_TIER_ID ? undefined : picked)
      ports.notice('service tier set to ' + (picked === PROVIDER_DEFAULT_TIER_ID ? 'provider default' : picked) + ' for the next request')
    } catch {
      ports.notice(saving ? SAVE_FAILURE : DISCOVERY_FAILURE)
    } finally {
      opening = false
      ports.render()
    }
  }
}
