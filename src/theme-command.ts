import type { ThemeOverrides } from './theme-settings.ts'
import { DEFAULT_PALETTE, DEFAULT_TOKENS, TUI_TOKENS, type TuiToken } from './theme-tokens.ts'

/** Where a token's value came from, which is what a reader debugging it needs. */
type Source = 'override' | 'palette' | 'default'

/**
 * Describe one token's effective value and its origin.
 *
 * A settings file that does nothing looks exactly like one that works, so the
 * reader needs to see which layer won: an override they wrote, the palette it
 * named, or the shipped default it never touched.
 */
function describeToken(token: TuiToken, overrides: ThemeOverrides): { text: string; source: Source } {
  const override = overrides.tokens.get(token)
  const spec = override ?? DEFAULT_TOKENS[token]
  const fields: string[] = []
  if (spec.fg !== undefined) fields.push(String(spec.fg))
  if (spec.bg !== undefined) fields.push(`bg ${String(spec.bg)}`)
  for (const attribute of ['bold', 'dim', 'italic', 'underline', 'strike'] as const) {
    if (spec[attribute] === true) fields.push(attribute)
  }
  if (spec.glyph !== undefined && spec.glyph !== '') fields.push(`glyph ${JSON.stringify(spec.glyph)}`)
  if (spec.hidden === true) fields.push('hidden')
  if (spec.inherit !== undefined) fields.push(`inherit ${spec.inherit}`)
  const named = typeof spec.fg === 'string' && spec.fg in DEFAULT_PALETTE && !spec.fg.startsWith('#')
  const source: Source = override !== undefined ? 'override' : named ? 'palette' : 'default'
  return { text: fields.length === 0 ? 'plain' : fields.join(' '), source }
}

/**
 * The effective table, one line per element.
 *
 * The token name comes first because it is what the reader types into
 * settings.yaml; the origin comes last because it is what explains the value
 * when the value is not what they expected.
 */
export function renderThemeTable(overrides: ThemeOverrides): string[] {
  const lines = [`theme · ${TUI_TOKENS.length} elements`, '']
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
  lines.push('', 'edit ~/.dsh/settings.yaml under "dsh-tui:" · /theme shows the result')
  return lines
}
