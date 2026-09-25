// The shape of a theme, wherever it is written.
//
// One definition for two readers: a `tokens:` block means the same thing in
// settings.yaml as it does in a theme file, and a colour the surface cannot draw
// has to be refused the same way in both. Sharing it here is also what keeps the
// two readers independent — neither has to know about the other to validate what
// it was handed, so a theme file still loads with no settings service mounted.

import z from '@deepseek-ai/schemastery'
import { DEFAULT_PALETTE } from './theme-defaults.ts'
import { PALETTE_NAMES, TUI_TOKENS, type PaletteName, type StyleSpec } from './theme-tokens.ts'

/**
 * A colour a writer may name.
 *
 * Enumerated rather than a free string: a misspelled colour must fail at load
 * with the offending value named, not silently paint nothing for the rest of the
 * session. A bare number is a terminal's own 256-colour index, which is what
 * makes a theme portable to a palette the surface cannot see.
 */
export const ColourSchema = z.union([
  z.string().pattern(/^#[0-9a-fA-F]{6}$/u),
  z.union([...PALETTE_NAMES]),
  z.number().min(0).max(255),
])

/** One element's appearance; every field optional so a writer sets only what they mean. */
export const StyleSpecSchema = z.object({
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
export const PaletteSchema = z.object(Object.fromEntries(
  PALETTE_NAMES.map(name => [name, ColourSchema.default(DEFAULT_PALETTE[name])]),
))

/**
 * The token half: every element optional, but an unknown name rejected.
 *
 * Spelled out rather than `z.dict` because `dict` would accept any key, which is
 * exactly the silent-typo failure this schema has to prevent.
 */
export const TokensSchema = z.object(Object.fromEntries(
  TUI_TOKENS.map(token => [token, StyleSpecSchema]),
))

/** Every element the surface draws, for refusing a name it does not know. */
export const TOKEN_NAME_SET: ReadonlySet<string> = new Set(TUI_TOKENS)

/** Every palette entry the surface has, for the same reason. */
export const PALETTE_NAME_SET: ReadonlySet<string> = new Set(PALETTE_NAMES)

/** A mapping as it was written, or undefined when the value is not one. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/**
 * Names in a written block that the surface does not have.
 *
 * Schemastery keeps a key it did not declare, so without this check a misspelled
 * element or palette entry would parse cleanly and do nothing at all — the one
 * outcome a writer could not debug from the screen.
 */
export function unknownNames(block: unknown, known: ReadonlySet<string>): string[] {
  return Object.keys(asRecord(block) ?? {}).filter(name => !known.has(name))
}

/** The palette a written block set, keeping only the entries it named. */
export function writtenPalette(raw: unknown): Readonly<Partial<Record<PaletteName, string>>> {
  const written: Record<string, string> = (asRecord(raw) ?? {}) as Record<string, string>
  const validated = PaletteSchema(written) as Record<PaletteName, string>
  const palette: Partial<Record<PaletteName, string>> = {}
  for (const name of Object.keys(written)) palette[name as PaletteName] = validated[name as PaletteName]
  return palette
}

/**
 * The elements a written block named, with the spec each was given.
 *
 * An empty spec is kept rather than dropped: a full reference says "this element
 * ships plain" by writing `{}`, and dropping it would leave the reference one
 * element short of the table it documents.
 */
export function writtenTokens(raw: unknown): Readonly<Partial<Record<string, StyleSpec>>> {
  const written: Record<string, StyleSpec> = (asRecord(raw) ?? {}) as Record<string, StyleSpec>
  const validated = TokensSchema(written) as Record<string, StyleSpec>
  const tokens: Record<string, StyleSpec> = {}
  for (const name of Object.keys(written)) tokens[name] = validated[name] ?? {}
  return tokens
}
