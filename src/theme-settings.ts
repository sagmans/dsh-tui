import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'
import {
  DEFAULT_PALETTE,
  PALETTE_NAMES,
  TUI_TOKENS,
  type PaletteName,
  type StyleSpec,
  type TuiToken,
} from './theme-tokens.ts'

/** Settings namespace owned by the terminal surface. */
export const TUI_SETTINGS_NAMESPACE = 'dsh-tui'

/**
 * A colour the reader may write.
 *
 * Enumerated rather than a free string: a misspelled colour must fail at load
 * with the offending token named, not silently paint nothing for the rest of
 * the session.
 */
const ColourSchema = z.union([
  z.const('#000000'),
  z.string().pattern(/^#[0-9a-fA-F]{6}$/u),
  z.union([...PALETTE_NAMES]),
  z.number().min(0).max(255),
])

/** One element's override; every field optional so a reader sets only what they mean. */
const StyleSpecSchema = z.object({
  fg: ColourSchema,
  bg: ColourSchema,
  bold: z.boolean(),
  dim: z.boolean(),
  italic: z.boolean(),
  underline: z.boolean(),
  strike: z.boolean(),
  glyph: z.string(),
  hidden: z.boolean(),
  inherit: z.union([...TUI_TOKENS]),
})

/** The palette half: every entry optional, each defaulting to the shipped shade. */
const PaletteSchema = z.object(Object.fromEntries(
  PALETTE_NAMES.map(name => [name, ColourSchema.default(DEFAULT_PALETTE[name])]),
))

/**
 * The token half: every token optional, but an unknown name rejected.
 *
 * Spelled out rather than `z.dict` because `dict` would accept any key, which
 * is exactly the silent-typo failure this section has to prevent.
 */
const TokensSchema = z.object(Object.fromEntries(
  TUI_TOKENS.map(token => [token, StyleSpecSchema]),
))

const SECTION = z.object({
  palette: PaletteSchema.default({}),
  tokens: TokensSchema.default({}),
})

/**
 * The schema the harness registers.
 *
 * Exported alongside the parser because registration needs a real schemastery
 * schema, while reading needs the unknown-token check that a schemastery object
 * cannot express.
 */
export const TuiSettingsSchema = SECTION

const TOKEN_NAMES = new Set<string>(TUI_TOKENS)

/**
 * Validate the raw section, refusing a token name the surface does not have.
 *
 * Schemastery's object schema ignores undeclared keys, so a misspelled token
 * would otherwise parse cleanly and do nothing at all — the one outcome a
 * reader could not debug from the screen. The names are therefore checked
 * against the union before validation.
 */
function rejectUnknownTokens(raw: unknown): void {
  const tokens = asRecord(asRecord(raw)?.tokens)
  if (tokens === undefined) return
  const unknown = Object.keys(tokens).filter(name => !TOKEN_NAMES.has(name))
  if (unknown.length > 0) {
    throw new Error(`unknown ${TUI_SETTINGS_NAMESPACE} token${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`)
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/** The reader-facing shape of the `dsh-tui:` section. */
export function parseSettings(raw: unknown): TuiSettings {
  rejectUnknownTokens(raw)
  const section = asRecord(raw) ?? {}
  const parsed = SECTION(section) as { palette: Record<PaletteName, string>; tokens: Record<string, StyleSpec> }
  // Only what the reader actually wrote is an override: the schema fills every
  // field so validation can see a whole section, but returning those fills
  // would turn a one-line override into a table of empty entries.
  const writtenPalette = asRecord(section.palette) ?? {}
  const palette: Record<string, string> = {}
  for (const [name, value] of Object.entries(writtenPalette)) {
    if (value !== undefined) palette[name] = parsed.palette[name as PaletteName]
  }
  const writtenTokens = asRecord(section.tokens) ?? {}
  const tokens: Record<string, StyleSpec> = {}
  for (const [name, value] of Object.entries(writtenTokens)) {
    if (value !== undefined) tokens[name] = parsed.tokens[name] ?? {}
  }
  return {
    palette: palette as Readonly<Partial<Record<PaletteName, string>>>,
    tokens: tokens as Readonly<Partial<Record<TuiToken, StyleSpec>>>,
  }
}

/** What the section holds once parsed: only what the reader wrote. */
export interface TuiSettings {
  readonly palette: Readonly<Partial<Record<PaletteName, string>>>
  readonly tokens: Readonly<Partial<Record<TuiToken, StyleSpec>>>
}

/** The section as it reads when the reader has written nothing. */
export function defaultSettings(): TuiSettings {
  return { palette: {}, tokens: {} }
}

/** The theme inputs a parsed section implies. */
export interface ThemeOverrides {
  readonly palette: Readonly<Record<PaletteName, string>>
  readonly tokens: ReadonlyMap<TuiToken, StyleSpec>
}

/**
 * Read a registered scope's section, or nothing when it cannot be read.
 *
 * A malformed section must not cost the reader their session: an unreadable
 * one falls back to the shipped table, which is the appearance the surface had
 * before any of this existed. It is loud on the way past, because a silently
 * ignored typo is the exact failure this section is meant to prevent.
 */
export function readScope(scope: { get(): unknown }): TuiSettings {
  try {
    return parseSettings(scope.get() ?? {})
  } catch (error) {
    process.stderr.write(`dsh-tui: ignoring ${TUI_SETTINGS_NAMESPACE} settings: ${error instanceof Error ? error.message : String(error)}\n`)
    return defaultSettings()
  }
}

/**
 * Turn a parsed section into the inputs the resolver takes.
 *
 * Shipped defaults fill anything the reader left out, so a partial section is
 * the normal case rather than something the resolver has to guard against.
 */
export function toOverrides(settings: TuiSettings): ThemeOverrides {
  const tokens = new Map<TuiToken, StyleSpec>()
  for (const [token, spec] of Object.entries(settings.tokens)) {
    if (spec !== undefined) tokens.set(token as TuiToken, spec)
  }
  return { palette: { ...DEFAULT_PALETTE, ...settings.palette }, tokens }
}
