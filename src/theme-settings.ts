import type { KeyId } from '@earendil-works/pi-tui'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'
import { DEFAULT_MAX_ENTRIES, MAX_ENTRIES_LIMIT } from './agent/prompt-history.ts'
import { defaultKeymap, keysFor, resolveKeymap, type KeyListValue, type Keymap } from './input/actions.ts'
import { KeymapSectionSchema, isActionId } from './input/keymap-settings.ts'
import { DEFAULT_PREFIX_KEYS, DEFAULT_PREFIX_WINDOW_S } from './input/keymap.ts'
import {
  TOOL_DISPLAY_LIMITS,
  TOOL_OUTPUT_DISPLAYS,
  toolDisplayTable,
  type ToolDisplayTable,
  type ToolOutputDisplay,
  type WrittenToolDisplay,
} from './tool-display.ts'
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

/** How nested PTC calls draw: nothing beyond the card, or one indented line per dispatched call. */
export type SubCallDisplay = 'collapsed' | 'inline'

/** The values the `subcalls` key accepts, declared once for the schema and the refusal message. */
const SUBCALL_DISPLAYS = ['collapsed', 'inline'] as const

/** How a reply's mermaid fences draw: never, once settled, or as the reply streams. */
export const MERMAID_MODES = ['off', 'final', 'streaming'] as const
export type MermaidMode = (typeof MERMAID_MODES)[number]

/** The shipped mode: a diagram draws itself while the reply arrives, without waiting for the turn. */
const DEFAULT_MERMAID_MODE: MermaidMode = 'streaming'

/** Longest chord window a reader may ask for, so a typo cannot arm one for an hour. */
const MAX_PREFIX_WINDOW_S = 60

/** Prompt history is on, and offers the dimmed completion, until the reader says otherwise. */
const DEFAULT_HISTORY_ENABLED = true
const DEFAULT_HISTORY_GHOST = true

/** The history keys, declared once so a typo is refused by name. */
const HISTORY_KEYS = new Set(['enabled', 'ghost', 'maxEntries'])

/**
 * The prompt-history affordances.
 *
 * Grouped under one key because they are tuned together: a reader who wants no
 * ghost still keeps reverse search, and one who wants neither stops the store.
 */
const HistorySchema = z.object({
  enabled: z.boolean().default(DEFAULT_HISTORY_ENABLED),
  ghost: z.boolean().default(DEFAULT_HISTORY_GHOST),
  maxEntries: z.number().min(1).max(MAX_ENTRIES_LIMIT).default(DEFAULT_MAX_ENTRIES),
})

const SECTION = z.object({
  palette: PaletteSchema.default({}),
  tokens: TokensSchema.default({}),
  subcalls: z.union([...SUBCALL_DISPLAYS]).default('inline'),
  mermaid: z.union([...MERMAID_MODES]).default(DEFAULT_MERMAID_MODE),
  // A free string rather than an enumerated union: the keymap module owns which
  // keys exist, and its refusal is the message a reader can act on.
  //
  // No default, unlike the fields around it: a registration fills every declared
  // field, so a default here would hand back the old spelling as written and the
  // reader's own keys.chord.prefix would read as a second spelling of it.
  prefix: z.string(),
  prefixWindow: z.number().min(0).max(MAX_PREFIX_WINDOW_S).default(DEFAULT_PREFIX_WINDOW_S),
  keys: KeymapSectionSchema.default({}),
  history: HistorySchema.default({ enabled: DEFAULT_HISTORY_ENABLED, ghost: DEFAULT_HISTORY_GHOST, maxEntries: DEFAULT_MAX_ENTRIES }),
  // Declared so a registered scope keeps the block when the document is saved,
  // but validated by hand below: its keys are tool names, which no closed shape
  // can enumerate, and schemastery's `dict` accepts every one of them.
  tools: z.any(),
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
const PALETTE_NAME_SET = new Set<string>(PALETTE_NAMES)

/** The section's own keys: schemastery keeps what it does not declare, so a misspelling has to be refused here. */
const SECTION_KEYS = new Set(['palette', 'tokens', 'subcalls', 'mermaid', 'prefix', 'prefixWindow', 'keys', 'history', 'tools'])

/** The fields one tool's row may carry, for the same reason the section's own keys are spelled out. */
const TOOL_FIELDS = new Set(['collapsed', 'maxArgument', 'output', 'tail'])

/**
 * Validate the raw section, refusing a name the surface does not have.
 *
 * Schemastery's object schema ignores undeclared keys, so a misspelled token,
 * palette entry, or key would otherwise parse cleanly and do nothing at all —
 * the one outcome a reader could not debug from the screen. Every level is
 * therefore checked against its declared names before validation.
 */
function rejectUnknownKeys(raw: unknown): void {
  const section = asRecord(raw)
  if (section === undefined) return
  const unknownKeys = Object.keys(section).filter(name => !SECTION_KEYS.has(name))
  if (unknownKeys.length > 0) {
    throw new Error(`unknown ${TUI_SETTINGS_NAMESPACE} key${unknownKeys.length === 1 ? '' : 's'}: ${unknownKeys.join(', ')}`)
  }
  const unknownTokens = Object.keys(asRecord(section.tokens) ?? {}).filter(name => !TOKEN_NAMES.has(name))
  if (unknownTokens.length > 0) {
    throw new Error(`unknown ${TUI_SETTINGS_NAMESPACE} token${unknownTokens.length === 1 ? '' : 's'}: ${unknownTokens.join(', ')}`)
  }
  const unknownPalette = Object.keys(asRecord(section.palette) ?? {}).filter(name => !PALETTE_NAME_SET.has(name))
  if (unknownPalette.length > 0) {
    throw new Error(`unknown ${TUI_SETTINGS_NAMESPACE} palette entr${unknownPalette.length === 1 ? 'y' : 'ies'}: ${unknownPalette.join(', ')}`)
  }
  const unknownActions = Object.keys(asRecord(section.keys) ?? {}).filter(name => !isActionId(name))
  if (unknownActions.length > 0) {
    throw new Error(`unknown ${TUI_SETTINGS_NAMESPACE} key action${unknownActions.length === 1 ? '' : 's'}: ${unknownActions.join(', ')}`)
  }
  const unknownHistory = Object.keys(asRecord(section.history) ?? {}).filter(name => !HISTORY_KEYS.has(name))
  if (unknownHistory.length > 0) {
    throw new Error('unknown ' + TUI_SETTINGS_NAMESPACE + ' history key' + (unknownHistory.length === 1 ? '' : 's') + ': ' + unknownHistory.join(', '))
  }
  const unknownToolFields = Object.entries(asRecord(section.tools) ?? {})
    .flatMap(([tool, spec]) => Object.keys(asRecord(spec) ?? {})
      .filter(field => !TOOL_FIELDS.has(field))
      .map(field => `${tool}.${field}`))
  if (unknownToolFields.length > 0) {
    throw new Error('unknown ' + TUI_SETTINGS_NAMESPACE + ' tool field' + (unknownToolFields.length === 1 ? '' : 's') + ': ' + unknownToolFields.join(', '))
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/** One display flag as the reader wrote it. */
function toolFlag(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`)
  return value
}

/** One bounded count as the reader wrote it. */
function toolInteger(value: unknown, field: string, bounds: { readonly min: number; readonly max: number }): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) {
    throw new Error(`${field} must be an integer between ${bounds.min} and ${bounds.max}`)
  }
  return value
}

/** One `output` value as the reader wrote it. */
function toolOutput(value: unknown, field: string): ToolOutputDisplay {
  if (typeof value !== 'string' || !(TOOL_OUTPUT_DISPLAYS as readonly string[]).includes(value)) {
    throw new Error(`${field} must be one of: ${TOOL_OUTPUT_DISPLAYS.join(', ')}`)
  }
  return value as ToolOutputDisplay
}

/**
 * The `tools:` block as the reader wrote it.
 *
 * The reserved `default` row and every tool name are the same shape, so they
 * are validated the same way; a name nothing declares is inert rather than an
 * error, because the surface cannot know which tools a profile mounts.
 */
function parseTools(raw: unknown): Record<string, WrittenToolDisplay> {
  const block = asRecord(raw) ?? {}
  const specs: Record<string, WrittenToolDisplay> = {}
  for (const [tool, value] of Object.entries(block)) {
    const spec = asRecord(value)
    if (spec === undefined) throw new Error(`tools.${tool} must be a mapping of display fields`)
    const written: WrittenToolDisplay = {}
    if (spec.collapsed !== undefined) written.collapsed = toolFlag(spec.collapsed, `tools.${tool}.collapsed`)
    if (spec.maxArgument !== undefined) {
      written.maxArgument = toolInteger(spec.maxArgument, `tools.${tool}.maxArgument`, TOOL_DISPLAY_LIMITS.maxArgument)
    }
    if (spec.output !== undefined) written.output = toolOutput(spec.output, `tools.${tool}.output`)
    if (spec.tail !== undefined) written.tail = toolInteger(spec.tail, `tools.${tool}.tail`, TOOL_DISPLAY_LIMITS.tail)
    specs[tool] = written
  }
  return specs
}

/** The reader-facing shape of the `dsh-tui:` section. */
export function parseSettings(raw: unknown): TuiSettings {
  rejectUnknownKeys(raw)
  const section = asRecord(raw) ?? {}
  const parsed = SECTION(section) as unknown as {
    palette: Record<PaletteName, string>
    tokens: Record<string, StyleSpec>
    subcalls: SubCallDisplay
    mermaid: MermaidMode
    prefix: string
    prefixWindow: number
    keys: Record<string, KeyListValue>
    history: HistorySettings
  }
  // Only what the reader actually wrote is an override: the schema fills every
  // field so validation can see a whole section, but returning those fills
  // would turn a one-line override into a table of empty entries.
  const writtenPalette = asRecord(section.palette) ?? {}
  const palette: Record<string, string> = {}
  for (const [name, value] of Object.entries(writtenPalette)) {
    // Same fill-in problem as the tokens: the schema supplies a default for
    // every entry, so only a value the reader chose is an override.
    if (value === undefined || value === DEFAULT_PALETTE[name as PaletteName]) continue
    palette[name] = parsed.palette[name as PaletteName]
  }
  const writtenTokens = asRecord(section.tokens) ?? {}
  const tokens: Record<string, StyleSpec> = {}
  for (const [name, value] of Object.entries(writtenTokens)) {
    // A registered scope hands back every key the schema declares, with an
    // empty spec for the ones nobody wrote. An empty spec cannot change an
    // appearance, so keeping it would let the schema's own fill-in shadow the
    // shipped default and report every element as overridden.
    if (value === undefined || !hasAnyField(parsed.tokens[name])) continue
    tokens[name] = parsed.tokens[name] ?? {}
  }
  const writtenKeys = asRecord(section.keys) ?? {}
  // The old spelling and the map set the same key; accepting both would make
  // the document mean two things at once.
  if (section.prefix !== undefined && writtenKeys['chord.prefix'] !== undefined) {
    throw new Error('prefix and keys.chord.prefix set the same key; write keys.chord.prefix alone')
  }
  // Only what the reader wrote reaches the map: the schema fills every action so
  // validation can see a whole section, and a fill-in would report every action
  // as overridden.
  const overrides: Record<string, KeyListValue> = {}
  for (const [id, value] of Object.entries(parsed.keys)) {
    if (value !== undefined) overrides[id] = value
  }
  if (parsed.prefix !== undefined) overrides['chord.prefix'] = parsed.prefix
  // Validated here rather than in the schema because every refusal depends on
  // the catalog and on the layers the map already claims, which a schema cannot see.
  const keymap = resolveKeymap(overrides)
  return {
    palette: palette as Readonly<Partial<Record<PaletteName, string>>>,
    tokens: tokens as Readonly<Partial<Record<TuiToken, StyleSpec>>>,
    subcalls: parsed.subcalls,
    tools: toolDisplayTable(parseTools(section.tools)),
    mermaid: parsed.mermaid,
    prefixes: keysFor(keymap, 'chord.prefix'),
    prefixWindow: parsed.prefixWindow,
    keymap,
    history: parsed.history,
  }
}

/** Whether a resolved spec actually asks for anything. */
function hasAnyField(spec: StyleSpec | undefined): boolean {
  if (spec === undefined) return false
  return Object.values(spec).some(value => value !== undefined)
}

/** The prompt-history affordances and the size the reader allows. */
export interface HistorySettings {
  /** Whether prompts are recorded and offered at all. */
  readonly enabled: boolean
  /** Whether the dimmed completion is drawn; reverse search is unaffected. */
  readonly ghost: boolean
  /** Entries kept, newest first. */
  readonly maxEntries: number
}

/** What the section holds once parsed: only what the reader wrote. */
export interface TuiSettings {
  readonly palette: Readonly<Partial<Record<PaletteName, string>>>
  readonly tokens: Readonly<Partial<Record<TuiToken, StyleSpec>>>
  readonly subcalls: SubCallDisplay
  readonly mermaid: MermaidMode
  /** The keys that start a chord; a key the surface answers itself is refused at parse. */
  readonly prefixes: readonly KeyId[]
  /** How long an armed chord waits for its second key, in seconds; zero waits for the next key. */
  readonly prefixWindow: number
  /** Every action's keys, with the reader's overrides already merged over the shipped ones. */
  readonly keymap: Keymap
  /** The prompt-history affordances, grouped so one key tunes them together. */
  readonly history: HistorySettings
  /** How each tool's cards draw: the block's own default, then the reader's per-tool rows. */
  readonly tools: ToolDisplayTable
}

/** The section as it reads when the reader has written nothing. */
export function defaultSettings(): TuiSettings {
  return {
    palette: {},
    tokens: {},
    subcalls: 'inline',
    tools: toolDisplayTable(),
    mermaid: DEFAULT_MERMAID_MODE,
    prefixes: [...DEFAULT_PREFIX_KEYS],
    prefixWindow: DEFAULT_PREFIX_WINDOW_S,
    keymap: defaultKeymap(),
    history: { enabled: DEFAULT_HISTORY_ENABLED, ghost: DEFAULT_HISTORY_GHOST, maxEntries: DEFAULT_MAX_ENTRIES },
  }
}

/** The theme inputs a parsed section implies. */
export interface ThemeOverrides {
  readonly palette: Readonly<Record<PaletteName, string>>
  readonly tokens: ReadonlyMap<TuiToken, StyleSpec>
}

/**
 * One sentence for a section the surface refused.
 *
 * Shared by the stderr fallback and the reader-facing notice so a refusal the
 * schema makes at registration and one the parser makes on a read read alike.
 */
export function settingsProblemMessage(error: unknown): string {
  return `ignoring ${TUI_SETTINGS_NAMESPACE} settings: ${error instanceof Error ? error.message : String(error)}`
}

/**
 * Read a registered scope's section, or nothing when it cannot be read.
 *
 * A malformed section must not cost the reader their session: an unreadable
 * one falls back to the shipped table, which is the appearance the surface had
 * before any of this existed. The caller is told on the way past, because a
 * silently ignored typo is the exact failure this section is meant to prevent;
 * stderr alone is invisible under the alternate screen.
 */
export function readScope(scope: { get(): unknown }, onProblem?: (message: string) => void): TuiSettings {
  let raw: unknown = undefined
  try {
    raw = scope.get() ?? {}
    return parseSettings(raw)
  } catch (error) {
    const message = settingsProblemMessage(error)
    if (onProblem === undefined) process.stderr.write(`dsh-tui: ${message}\n`)
    else onProblem(message)
    // The rest of the refused section falls back to the shipped table, but
    // recording is a privacy choice: an explicit switch survives a typo
    // somewhere else, and a switch that could not be read stays off rather than
    // quietly turning the store back on.
    const fallback = defaultSettings()
    if (raw === undefined) return { ...fallback, history: { ...fallback.history, enabled: false } }
    return { ...fallback, history: salvageHistory(raw) }
  }
}

/**
 * The history block as far as it can be read from a refused section.
 *
 * Only the primitive shapes the schema would have accepted are taken; missing
 * and malformed fields fall back to the shipped value, except an unreadable
 * `enabled`, which refuses.
 */
function salvageHistory(raw: unknown): HistorySettings {
  const fallback = defaultSettings().history
  const history = asRecord(asRecord(raw)?.history)
  if (history === undefined) return fallback
  const enabled = history.enabled === undefined
    ? fallback.enabled
    : typeof history.enabled === 'boolean' ? history.enabled : false
  const ghost = typeof history.ghost === 'boolean' ? history.ghost : fallback.ghost
  const maxEntries = typeof history.maxEntries === 'number'
    && Number.isSafeInteger(history.maxEntries)
    && history.maxEntries >= 1
    && history.maxEntries <= MAX_ENTRIES_LIMIT
    ? history.maxEntries
    : fallback.maxEntries
  return { enabled, ghost, maxEntries }
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
