import { type ColourMode, sgrBackgroundPrefix, sgrPrefix } from './theme-capability.ts'
import { DEFAULT_TOKENS } from './theme-defaults.ts'
import { PALETTE_NAMES, type ColourSpec, type PaletteName, type StyleSpec, type ThemedSpecs, type TuiToken } from './theme-tokens.ts'
const RESET = '\u001B[0m'

/**
 * The reset sequence, for the code that has to recognise one.
 *
 * pi-tui closes a truncated row with a reset whether or not it opened a style,
 * so a renderer that turns styling off still has to remove the ones it did not
 * ask for.
 */
export function resetSequence(): string {
  return RESET
}

/** The resolved escape pair and marks one element needs. */
export interface ResolvedStyle {
  readonly prefix: string
  readonly suffix: string
  readonly glyph: string
  readonly hidden: boolean
}

/** Map a colour specification through the palette, leaving literals alone. */
function resolveColour(spec: ColourSpec, palette: Readonly<Record<PaletteName, string>>): string | number {
  if (typeof spec === 'string' && (PALETTE_NAMES as readonly string[]).includes(spec)) {
    return palette[spec as PaletteName]
  }
  return spec as string | number
}

/** Drop the routing field, so a merged spec carries only what it draws. */
function withoutInherit(spec: StyleSpec): StyleSpec {
  const { inherit: _routing, ...rest } = spec
  return rest
}

/** The fields an override really wrote, so an explicit `undefined` cannot shadow a default. */
function writtenFields(spec: StyleSpec | undefined): StyleSpec {
  if (spec === undefined) return {}
  const written: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(spec)) {
    if (value !== undefined) written[key] = value
  }
  return written as StyleSpec
}

/**
 * Merge one token's default, its `inherit` target, a theme, and the reader.
 *
 * The inherited token's fields replace this token's defaults, because that is
 * what "start from another token" means. A theme sits between the two because
 * it is a layer the reader chose rather than one they wrote: it moves every
 * element it names, and their own fields still have the last word.
 * A path-scoped set turns a cycle into a stop, and still lets two branches
 * inherit one token rather than sharing a single visit.
 */
export function mergeTokenSpec(
  token: TuiToken,
  overrides: ReadonlyMap<TuiToken, StyleSpec>,
  themed?: ThemedSpecs,
): StyleSpec {
  const visiting = new Set<TuiToken>()
  const merge = (name: TuiToken): StyleSpec => {
    if (visiting.has(name)) return {}
    visiting.add(name)
    const own = DEFAULT_TOKENS[name]
    const fromTheme = themed?.[name]
    const override = overrides.get(name)
    const parent = override?.inherit ?? fromTheme?.inherit ?? own.inherit
    const inherited = parent === undefined ? {} : merge(parent)
    visiting.delete(name)
    return {
      ...withoutInherit(own),
      ...inherited,
      ...withoutInherit(writtenFields(fromTheme)),
      ...withoutInherit(writtenFields(override)),
    }
  }
  return merge(token)
}

/** Turn a colour SGR sequence into the parameter list it belongs to. */
function colourParams(sequence: string): string | undefined {
  return sequence === '' ? undefined : sequence.slice('\u001B['.length, -1)
}

/**
 * Resolve one token into the escapes a renderer needs.
 *
 * Faint is dropped once a colour is chosen: stacking it on a deliberate grey is
 * what made the old output differ per terminal.
 */
export function resolveToken(
  token: TuiToken,
  overrides: ReadonlyMap<TuiToken, StyleSpec>,
  palette: Readonly<Record<PaletteName, string>>,
  mode: ColourMode,
  themed?: ThemedSpecs,
): ResolvedStyle {
  const merged = mergeTokenSpec(token, overrides, themed) as Record<string, unknown>
  if (merged.hidden === true) return { prefix: '', suffix: '', glyph: '', hidden: true }

  // With no colour capability the whole promise is "emit nothing", which
  // includes attributes: a bold word is still styling a reader turned off.
  if (mode === 'none') return { prefix: '', suffix: '', glyph: (merged.glyph as string | undefined) ?? '', hidden: false }

  const fg = merged.fg as ColourSpec | undefined
  const bg = merged.bg as ColourSpec | undefined
  const codes: string[] = []
  if (merged.bold === true) codes.push('1')
  if (merged.dim === true && fg === undefined) codes.push('2')
  if (merged.italic === true) codes.push('3')
  if (merged.underline === true) codes.push('4')
  if (merged.strike === true) codes.push('9')
  for (const params of [
    fg === undefined ? undefined : colourParams(sgrPrefix(resolveColour(fg, palette), mode)),
    bg === undefined ? undefined : colourParams(sgrBackgroundPrefix(resolveColour(bg, palette), mode)),
  ]) {
    if (params !== undefined) codes.push(params)
  }
  // One sequence for attributes and colours together: two escapes in a row would
  // let a renderer that re-orders them drop half the style.
  const prefix = codes.length === 0 ? '' : `\u001B[${codes.join(';')}m`
  return { prefix, suffix: prefix === '' ? '' : RESET, glyph: (merged.glyph as string | undefined) ?? '', hidden: false }
}
