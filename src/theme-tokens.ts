/** Palette entries a token may name instead of a literal colour. */
export const PALETTE_NAMES = ['default', 'muted', 'faint', 'accent', 'arg', 'warn', 'added', 'removed', 'user', 'assistant'] as const

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
  'transcript.assistant.border',
  'transcript.notice',
  'transcript.marker',
  'transcript.reasoning.summary',
  'transcript.reasoning.body',
  'transcript.reasoning.hint',
  // A reply's text is markdown, so the markdown tokens are what address it; only
  // the frame drawn around the reply has an element of its own.
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
  // A call still in flight is its own element: a reader who quiets the failed
  // row's colour must not also lose the one mark that says work is happening.
  // The seconds are two elements because they are two states — counting while
  // the call is unanswered, and the total a program's card keeps once it is not.
  'tool.running.title',
  'tool.running.elapsed',
  'tool.elapsed.done',
  'tool.subcall.title',
  'tool.subcall.running',
  'tool.subcall.args',
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
  // A fenced diff is drawn by the surface rather than by the library's plain
  // code path, so each row class is addressable on its own; the two emphasis
  // entries are the characters that changed inside an otherwise matching pair,
  // which is what tells an edit from a wholesale replacement.
  'markdown.diff.header',
  'markdown.diff.hunk',
  'markdown.diff.context',
  'markdown.diff.added',
  'markdown.diff.removed',
  'markdown.diff.addedEmphasis',
  'markdown.diff.removedEmphasis',
  // A drawn mermaid diagram: the renderer reports what each run *is*, so every
  // role a drawing can be made of is addressable on its own.
  'markdown.diagram.border',
  'markdown.diagram.text',
  'markdown.diagram.edge',
  'markdown.diagram.edgeLabel',
  'markdown.diagram.title',
  'markdown.diagram.warning',
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
  // A picker drawn as a box rather than a list at the end of the transcript:
  // the frame has to read as an overlay on the rows behind it, not as one more
  // element of them.
  'picker.border',
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
  'dock.todos.border',
  'dock.todos.heading',
  'dock.todos.pending',
  'dock.todos.inProgress',
  'dock.todos.overflow',
  'dock.subagents.border',
  'dock.subagents.heading',
  'dock.subagents.running',
  'dock.subagents.overflow',
  'dock.jobs.border',
  'dock.jobs.heading',
  'dock.jobs.running',
  'dock.jobs.overflow',
  // Status bar
  'status.prefix',
  'status.back',
  'status.activity.working',
  'status.activity.ready',
  'status.elapsed',
  'status.agentPreset',
  'status.model',
  'status.effort',
  'status.permission',
  'status.context',
  'status.cache',
  'status.stash',
  'status.cwd',
  'status.separator',
  // Editor
  'editor.border',
  'editor.queued',
  'editor.queued.more',
  'editor.ghost',
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

/** The elements a named theme draws its own way, as the layer a resolver takes. */
export type ThemedSpecs = Readonly<Partial<Record<TuiToken, StyleSpec>>>
