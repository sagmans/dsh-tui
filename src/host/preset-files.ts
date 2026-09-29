import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
// The type travels with the oldest line that has it; the alias is what the
// manifest declares, so the plain name would not resolve at all.
import type { PresetDefinition } from '@sagmans/dsh-agent-preset-registry-017'
import { DEFAULT_SCHEMA, Type, load as parseYaml } from 'js-yaml'
import type { HarnessLine } from './generation.ts'

/**
 * The agent modes this bundle ships, read from the same files the harness's own
 * bundles declare.
 *
 * The 0.1.7 line moved the modes out of the retired roster package and into one
 * row per mode, which each surface bundle owns for itself: the browser bundle
 * keeps them in its patch layer. A patch layer cannot do that here, because a
 * patch row is mounted before any service exists and so cannot tell the harness
 * lines apart. The files travel with this package and are parsed at the moment
 * the owning row applies.
 */

/**
 * The loader evaluates `disabled` through a marker object rather than a tag, so
 * the expression keeps working after the YAML round trip.
 */
const jsExpression = new Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (value: string) => ({ __jsExpr: value }),
})

/** The default tag set plus that expression, which is what a shipped mode uses. */
const presetSchema = DEFAULT_SCHEMA.extend([jsExpression])

/** Modes this bundle ships, in the order the picker lists them. */
export const PRESET_FILES = ['standard', 'ptc', 'minimal', 'cordis'] as const

/** Where a packed install keeps them: beside `lib`, as the manifest declares. */
const presetDirectory = new URL('../../presets/', import.meta.url)

/** The alias suffix each line's build of a row package lives under. */
const LINE_SUFFIX: Readonly<Record<HarnessLine, string>> = {
  '0.1.5': '015',
  '0.1.7': '017',
  '0.2.0': '020',
}

/**
 * Row packages this bundle ships a build of for every line.
 *
 * The modes name the plain package, which in a profile means the one release the
 * resolution can satisfy — and the harness reports its own version as the runtime
 * version, so an older copy of these is what makes a newer host disable its own
 * rows. The names are rewritten to this bundle's alias for the hosting line, and
 * every other row keeps the plain name its host bundle owns.
 */
const LINE_ALIASED_PACKAGES = [
  'dsh-agent-preset',
  'dsh-agent-preset-registry',
  'dsh-agent-tool-presentation',
  'dsh-persona',
  'dsh-plugin-manager',
  'dsh-terminal',
  'dsh-terminal-bash',
  'dsh-tool-ask-user',
  'dsh-tool-bash-persistent',
  'dsh-tool-cordis',
  'dsh-tool-pwsh-persistent',
  'dsh-tool-subagent-control',
] as const

/** The alias this bundle installs for a row package on the hosting line. */
export function rowNameForLine(name: string, line: HarnessLine): string {
  const plain = LINE_ALIASED_PACKAGES.find(candidate => name === '@deepseek-ai/' + candidate)
  return plain === undefined ? name : '@sagmans/' + plain + '-' + LINE_SUFFIX[line]
}

/**
 * Read every shipped mode for the hosting line.
 *
 * A parse failure is not swallowed: a mode that cannot be read would vanish from
 * the roster without saying so, and a session that starts in it would fail with
 * no cause on screen.
 */
export function loadPresetDefinitions(line: HarnessLine): readonly PresetDefinition[] {
  return PRESET_FILES.map((mode) => {
    const file = fileURLToPath(new URL(`${mode}.patch.yml`, presetDirectory))
    const document = parseYaml(readFileSync(file, 'utf8'), { schema: presetSchema }) as readonly { insert?: readonly { config?: unknown }[] }[]
    const rows = document.flatMap((entry) => entry?.insert ?? [])
    if (rows.length !== 1) throw new Error(`${file}: expected one preset row, found ${rows.length}`)
    const definition = rows[0]?.config as PresetDefinition
    return {
      ...definition,
      plugins: definition.plugins.map(row => ({ ...row, name: rowNameForLine(String(row.name), line) })),
    }
  })
}
