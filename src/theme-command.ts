import type { ThemeOverrides } from './theme-settings.ts'
import { presetTokens, SHIPPED_THEME, THEME_NAMES } from './theme-presets.ts'
import { mergeTokenSpec, PALETTE_NAMES, TUI_TOKENS, type ColourSpec, type PaletteName, type TuiToken } from './theme-tokens.ts'

/** Where a token's value came from, which is what a reader debugging it needs. */
type Source = 'override' | 'preset' | 'palette' | 'default'

/** A colour as the reader would see it applied, with a palette name resolved. */
function showColour(spec: ColourSpec, palette: Readonly<Record<PaletteName, string>>): string {
  if (typeof spec === 'string' && (PALETTE_NAMES as readonly string[]).includes(spec)) {
    return palette[spec as PaletteName]
  }
  return String(spec)
}

/**
 * Describe one token's effective value and its origin.
 *
 * A settings file that does nothing looks exactly like one that works, so the
 * reader needs to see which layer won: an override they wrote, the palette it
 * named, or the shipped default it never touched. The value is the merged one a
 * renderer would apply, not the fragment the reader happened to write.
 */
function describeToken(token: TuiToken, overrides: ThemeOverrides): { text: string; source: Source } {
  const spec = mergeTokenSpec(token, overrides.tokens, presetTokens(overrides.preset))
  const fields: string[] = []
  if (spec.fg !== undefined) fields.push(showColour(spec.fg, overrides.palette))
  if (spec.bg !== undefined) fields.push(`bg ${showColour(spec.bg, overrides.palette)}`)
  for (const attribute of ['bold', 'dim', 'italic', 'underline', 'strike'] as const) {
    if (spec[attribute] === true) fields.push(attribute)
  }
  if (spec.glyph !== undefined && spec.glyph !== '') fields.push(`glyph ${JSON.stringify(spec.glyph)}`)
  if (spec.hidden === true) fields.push('hidden')
  const named = typeof spec.fg === 'string' && (PALETTE_NAMES as readonly string[]).includes(spec.fg)
  const themed = presetTokens(overrides.preset)?.[token] !== undefined
  // A theme is a layer the reader chose, not one they wrote: the file to edit
  // differs, so the two get their own answer even when both set one element.
  const source: Source = overrides.tokens.has(token) ? 'override'
    : themed ? 'preset'
    : named ? 'palette' : 'default'
  return { text: fields.length === 0 ? 'plain' : fields.join(' '), source }
}

/** Where the reader edits the section; the home is a variable, not a fixed path. */
const SETTINGS_HINT = 'edit $DSH_HOME/settings.yaml (default ~/.dsh/settings.yaml) under "dsh-tui:" · /theme shows the result'

/**
 * The effective table, one line per element.
 *
 * The token name comes first because it is what the reader types into
 * settings.yaml; the origin comes last because it is what explains the value
 * when the value is not what they expected.
 */
export function renderThemeTable(overrides: ThemeOverrides): string[] {
  // The name is in the heading rather than the footer because a reader who
  // opened this to find out why a shade moved needs it before the table.
  const name = overrides.preset === undefined || overrides.preset === SHIPPED_THEME ? '' : ` · ${overrides.preset}`
  const lines = [`theme${name} · ${TUI_TOKENS.length} elements`, '']
  let group = ''
  for (const token of TUI_TOKENS) {
    const head = token.split('.')[0] ?? token
    if (head !== group) {
      group = head
      lines.push(`${group}:`)
    }
    const { text, source } = describeToken(token, overrides)
    lines.push(`  ${token} = ${text} (${source})`)
  }
  lines.push('', `palette: ${Object.entries(overrides.palette).map(([name, value]) => `${name} ${value}`).join(' · ')}`)
  lines.push('', `themes: ${THEME_NAMES.join(' · ')} — /theme <name> applies one`)
  lines.push('', SETTINGS_HINT)
  return lines
}
