import { type ColourMode, sgrBackgroundPrefix, sgrPrefix } from './theme-capability.ts'

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

/**
 * The muted shade every receding element shares.
 *
 * An explicit grey rather than a palette slot: slot 8 is whatever the reader's
 * terminal maps it to, which on the reader's own phone was close enough to
 * ordinary text that dimming looked like it had not been applied at all.
 */
export const MUTED_GREY = '#8a8a8a'

/**
 * The shade a tool's argument takes.
 *
 * A call's argument is the one part of a card the reader scans for, and it must
 * read as neither the tool's own label (warn) nor ordinary output (the default
 * foreground); a pale blue sits between them without competing for attention.
 */
export const ARGUMENT_BLUE = '#8db3d9'

/**
 * The shade a submitted prompt takes.
 *
 * A reader's own turns and the assistant's reply both shipped on the default
 * foreground, so telling the two apart meant reading them; a rose separates
 * them at a glance while staying quieter than the warn-coloured tool label.
 */
export const USER_PROMPT_ROSE = '#FCCAF0'

/** Palette entries a token may name instead of a literal colour. */
export const PALETTE_NAMES = ['default', 'muted', 'accent', 'arg', 'warn', 'added', 'removed', 'user', 'assistant'] as const

/** A named palette entry. */
export type PaletteName = (typeof PALETTE_NAMES)[number]

/** A colour: an explicit hex value, or a palette entry. */
export type ColourSpec = string | number | PaletteName

/** One element's appearance, every field optional so a reader sets only what they mean. */
export interface StyleSpec {
  readonly fg?: ColourSpec
  readonly bg?: ColourSpec
  readonly bold?: boolean
  readonly dim?: boolean
  readonly italic?: boolean
  readonly underline?: boolean
  readonly strike?: boolean
  /** Rendered before the element when set; empty ships nothing. */
  readonly glyph?: string
  /** The element renders nothing at all when true. */
  readonly hidden?: boolean
  /** Start from another token's fields instead of this token's own defaults. */
  readonly inherit?: TuiToken
}

/** The resolved escape pair and marks one element needs. */
export interface ResolvedStyle {
  readonly prefix: string
  readonly suffix: string
  readonly glyph: string
  readonly hidden: boolean
}

/** A row class a tool card can carry, so styling follows what the row means. */
export const CARD_ROW_CLASSES = [
  'header', 'hunk', 'added', 'removed', 'line', 'lineNumber', 'path', 'match', 'truncated', 'output', 'cwd', 'status', 'source', 'url', 'detail',
] as const

/** What a tool card row is, which is what decides how it is drawn. */
export type CardRowClass = (typeof CARD_ROW_CLASSES)[number]

/**
 * Every styled element on the surface, grouped by the region that draws it.
 *
 * The list is the contract: a renderer names a token, and the coverage sweep
 * fails if a token loses its default, so "every element" cannot quietly drift
 * as the surface grows.
 */
export const TUI_TOKENS = [
  // Transcript rows
  'transcript.user',
  'transcript.notice',
  'transcript.marker',
  'transcript.reasoning.summary',
  'transcript.reasoning.body',
  'transcript.reasoning.hint',
  // A reply is markdown, so the markdown tokens are what address it.
  // Tool cards: the generic layer
  'tool.title',
  'tool.glyph',
  'tool.args',
  'tool.stat.added',
  'tool.stat.changed',
  'tool.stat.removed',
  'tool.stat.size',
  'tool.stat.separator',
  'tool.detail',
  'tool.hint',
  'tool.failed.title',
  'tool.failed.glyph',
  // Tool cards: per kind
  'tool.diff.header',
  'tool.diff.hunk',
  'tool.diff.added',
  'tool.diff.removed',
  'tool.read.header',
  'tool.read.lineNumber',
  'tool.read.line',
  'tool.search.path',
  'tool.search.lineNumber',
  'tool.search.match',
  'tool.search.truncated',
  'tool.terminal.cwd',
  'tool.terminal.status',
  'tool.terminal.output',
  'tool.web.url',
  'tool.web.source',
  'tool.web.truncated',
  'tool.generic.detail',
  // Markdown
  'markdown.heading',
  'markdown.link',
  'markdown.linkUrl',
  'markdown.code',
  'markdown.codeBlock',
  'markdown.codeBlockBorder',
  'markdown.quote',
  'markdown.quoteBorder',
  'markdown.hr',
  'markdown.listBullet',
  'markdown.bold',
  'markdown.italic',
  'markdown.strikethrough',
  'markdown.underline',
  // No markdown.tableHeader: pi-tui styles table headers through the bold hook
  // it already owns, so a token here would be a setting with no call site.
  // Picker
  'picker.title',
  'picker.glyph',
  'picker.note',
  'picker.filter',
  'picker.row',
  'picker.rowCurrent',
  'picker.scrollNewer',
  'picker.scrollOlder',
  'picker.hint',
  'picker.cursor',
  // Gate
  'gate.title',
  'gate.glyphApproval',
  'gate.glyphQuestion',
  'gate.detail',
  'gate.option',
  'gate.optionCurrent',
  'gate.cursor',
  'gate.hint',
  // Dock
  'dock.goal',
  'dock.planMode',
  'dock.todos.heading',
  'dock.todos.pending',
  'dock.todos.inProgress',
  'dock.todos.overflow',
  'dock.subagents.heading',
  'dock.subagents.running',
  'dock.subagents.overflow',
  'dock.jobs.heading',
  'dock.jobs.running',
  'dock.jobs.overflow',
  // Status bar
  'status.activity.working',
  'status.activity.ready',
  'status.elapsed',
  'status.agentPreset',
  'status.model',
  'status.effort',
  'status.permission',
  'status.context',
  'status.cache',
  'status.cwd',
  'status.separator',
  // Editor
  'editor.border',
  'editor.selectList.selectedPrefix',
  'editor.selectList.selectedText',
  'editor.selectList.description',
  'editor.selectList.scrollInfo',
  'editor.selectList.noMatch',
] as const

/** A name for one styled element on the surface. */
export type TuiToken = (typeof TUI_TOKENS)[number]

/**
 * Which token draws a card row, by the card's kind and the row's class.
 *
 * Two lookups rather than one because `header` means a different element on a
 * diff than on a read: the kind is half of what a row is.
 */
export const CARD_ROW_TOKEN: Readonly<Record<string, Readonly<Partial<Record<CardRowClass, TuiToken>>>>> = {
  diff: { header: 'tool.diff.header', hunk: 'tool.diff.hunk', added: 'tool.diff.added', removed: 'tool.diff.removed' },
  read: { header: 'tool.read.header', lineNumber: 'tool.read.lineNumber', line: 'tool.read.line' },
  search: {
    path: 'tool.search.path',
    lineNumber: 'tool.search.lineNumber',
    match: 'tool.search.match',
    truncated: 'tool.search.truncated',
  },
  terminal: { cwd: 'tool.terminal.cwd', status: 'tool.terminal.status', output: 'tool.terminal.output' },
  web: { url: 'tool.web.url', source: 'tool.web.source', truncated: 'tool.web.truncated' },
  generic: { detail: 'tool.generic.detail' },
}

/** The colours a token can name, so a shade is changed in one place. */
export const DEFAULT_PALETTE: Readonly<Record<PaletteName, string>> = {
  default: '#d0d0d0',
  muted: MUTED_GREY,
  accent: '#5fafd7',
  arg: ARGUMENT_BLUE,
  warn: '#d7af5f',
  added: '#5faf5f',
  removed: '#d75f5f',
  user: USER_PROMPT_ROSE,
  assistant: '#d0d0d0',
}

/**
 * Muted elements share one shade, which is what makes the surface coherent.
 *
 * It names the palette entry rather than repeating the hex, so a reader who
 * changes `palette.muted` once quiets every receding element together instead
 * of hunting the tokens down. No `dim` either: faint is dropped the moment a
 * colour is named, so carrying it would be a setting that does nothing.
 */
const muted: StyleSpec = { fg: 'muted' }
const plain: StyleSpec = {}

/**
 * The shipped appearance of every token.
 *
 * Defaults reproduce the surface as it looked before tokens existed, except the
 * muted family, which moves from faint-on-a-palette-slot to an explicit grey.
 * A test asserts every token in {@link TUI_TOKENS} appears here.
 */
export const DEFAULT_TOKENS: Readonly<Record<TuiToken, StyleSpec>> = {
  'transcript.user': { fg: 'user', bold: true },
  'transcript.notice': muted,
  'transcript.marker': muted,
  'transcript.reasoning.summary': muted,
  'transcript.reasoning.body': muted,
  'transcript.reasoning.hint': muted,

  'tool.title': { fg: 'warn' },
  'tool.glyph': { fg: 'warn' },
  'tool.args': { fg: 'arg' },
  'tool.stat.added': { fg: 'added' },
  'tool.stat.changed': { fg: 'warn' },
  'tool.stat.removed': { fg: 'removed' },
  'tool.stat.size': muted,
  'tool.stat.separator': muted,
  'tool.detail': muted,
  'tool.hint': muted,
  'tool.failed.title': { fg: 'removed' },
  'tool.failed.glyph': { fg: 'removed' },

  'tool.diff.header': muted,
  'tool.diff.hunk': muted,
  'tool.diff.added': { fg: 'added' },
  'tool.diff.removed': { fg: 'removed' },
  'tool.read.header': muted,
  'tool.read.lineNumber': muted,
  'tool.read.line': muted,
  'tool.search.path': muted,
  'tool.search.lineNumber': muted,
  'tool.search.match': muted,
  'tool.search.truncated': muted,
  'tool.terminal.cwd': muted,
  'tool.terminal.status': muted,
  'tool.terminal.output': muted,
  'tool.web.url': muted,
  'tool.web.source': muted,
  'tool.web.truncated': muted,
  'tool.generic.detail': muted,

  'markdown.heading': { fg: 'accent', bold: true },
  'markdown.link': { fg: 'accent', underline: true },
  'markdown.linkUrl': muted,
  'markdown.code': { fg: 'accent' },
  'markdown.codeBlock': plain,
  'markdown.codeBlockBorder': muted,
  'markdown.quote': muted,
  'markdown.quoteBorder': muted,
  'markdown.hr': muted,
  'markdown.listBullet': { fg: 'accent' },
  'markdown.bold': { bold: true },
  'markdown.italic': { italic: true },
  'markdown.strikethrough': { strike: true },
  'markdown.underline': { underline: true },

  'picker.title': { bold: true },
  'picker.glyph': { bold: true },
  'picker.note': { bold: true },
  'picker.filter': muted,
  'picker.row': plain,
  'picker.rowCurrent': { bold: true },
  'picker.scrollNewer': muted,
  'picker.scrollOlder': muted,
  'picker.hint': muted,
  'picker.cursor': plain,

  'gate.title': { bold: true },
  'gate.glyphApproval': { bold: true },
  'gate.glyphQuestion': { bold: true },
  'gate.detail': muted,
  'gate.option': plain,
  'gate.optionCurrent': { bold: true },
  'gate.cursor': plain,
  'gate.hint': muted,

  'dock.goal': { bold: true },
  'dock.planMode': { bold: true },
  'dock.todos.heading': { bold: true },
  'dock.todos.pending': muted,
  'dock.todos.inProgress': muted,
  'dock.todos.overflow': muted,
  'dock.subagents.heading': { bold: true },
  'dock.subagents.running': muted,
  'dock.subagents.overflow': muted,
  'dock.jobs.heading': { bold: true },
  'dock.jobs.running': muted,
  'dock.jobs.overflow': muted,

  'status.activity.working': muted,
  'status.activity.ready': muted,
  'status.elapsed': muted,
  'status.agentPreset': muted,
  'status.model': muted,
  'status.effort': muted,
  'status.permission': muted,
  'status.context': muted,
  'status.cache': muted,
  'status.cwd': muted,
  'status.separator': muted,

  'editor.border': muted,
  'editor.selectList.selectedPrefix': { fg: 'accent' },
  'editor.selectList.selectedText': { bold: true },
  'editor.selectList.description': muted,
  'editor.selectList.scrollInfo': muted,
  'editor.selectList.noMatch': muted,
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
 * Merge one token's default, its `inherit` target, and the reader's override.
 *
 * The inherited token's fields replace this token's defaults, because that is
 * what "start from another token" means; the reader's own fields still win.
 * A path-scoped set turns a cycle into a stop, and still lets two branches
 * inherit one token rather than sharing a single visit.
 */
export function mergeTokenSpec(token: TuiToken, overrides: ReadonlyMap<TuiToken, StyleSpec>): StyleSpec {
  const visiting = new Set<TuiToken>()
  const merge = (name: TuiToken): StyleSpec => {
    if (visiting.has(name)) return {}
    visiting.add(name)
    const own = DEFAULT_TOKENS[name]
    const override = overrides.get(name)
    const parent = override?.inherit ?? own.inherit
    const inherited = parent === undefined ? {} : merge(parent)
    visiting.delete(name)
    return { ...withoutInherit(own), ...inherited, ...withoutInherit(writtenFields(override)) }
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
): ResolvedStyle {
  const merged = mergeTokenSpec(token, overrides) as Record<string, unknown>
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
