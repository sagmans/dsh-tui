import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { load as parseYaml } from 'js-yaml'

/**
 * The agent modes this bundle ships, read from the same files the harness's own
 * bundles declare.
 *
 * A mode names a selection, not a composition: the rows that make up an agent's
 * tools, prompt sections, skills, and planning belong to the bundle shipping
 * each of them, so a mode that listed them would mount plugins this bundle does
 * not own — a second registration of what the profile already composed. These
 * files therefore carry the preset declaration alone.
 *
 * The harness keeps one row per mode, and each surface bundle owns its own rows:
 * the browser bundle keeps them in its patch layer. A patch row here would be
 * mounted before any service exists, so the files travel with this package and
 * are parsed at the moment the roster row applies them to the hosting registry.
 */

/** Modes this bundle ships, in the order the picker lists them. */
export const PRESET_FILES = ['standard', 'ptc', 'minimal', 'cordis'] as const

/** Where a packed install keeps them: beside `lib`, as the manifest declares. */
const presetDirectory = new URL('../../presets/', import.meta.url)

/**
 * Read every shipped mode.
 *
 * A parse failure is not swallowed: a mode that cannot be read would vanish from
 * the roster without saying so, and a session that starts in it would fail with
 * no cause on screen.
 */
export function loadPresetDefinitions(): readonly PresetDefinition[] {
  return PRESET_FILES.map((mode) => {
    const file = fileURLToPath(new URL(`${mode}.patch.yml`, presetDirectory))
    const document = parseYaml(readFileSync(file, 'utf8')) as readonly { insert?: readonly { config?: unknown }[] }[]
    const rows = document.flatMap((entry) => entry?.insert ?? [])
    if (rows.length !== 1) throw new Error(`${file}: expected one preset row, found ${rows.length}`)
    return rows[0]?.config as PresetDefinition
  })
}
