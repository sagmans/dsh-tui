import type { PaletteName, StyleSpec, TuiToken } from './theme-tokens.ts'
/**
 * The muted shade every receding element shares.
 *
 * An explicit grey rather than a palette slot: slot 8 is whatever the reader's
 * terminal maps it to, which on the reader's own phone was close enough to
 * ordinary text that dimming looked like it had not been applied at all.
 */
export const MUTED_GREY = '#8a8a8a'

/**
 * The shade the reasoning signpost recedes to.
 *
 * The row naming a thought is a signpost, not the thought: it sits below the
 * muted family so the body it introduces stays the thing being read.
 */
export const FAINT_GREY = '#666666'

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
 * foreground, so telling the two apart meant reading them; a mint keeps them
 * apart at a glance without the pink cast a rose gave every prompt.
 */
export const USER_PROMPT_MINT = '#27f5c8'

/**
 * The band a changed run sits on inside an added line.
 *
 * The characters that changed are why a paired line is on screen at all, and
 * they must stand out without leaving the row's own hue: a reader scanning a
 * green row should not have to compare it against a second, unrelated colour to
 * find what moved. An explicit dark shade rather than a palette slot, for the
 * same reason the muted grey is one.
 */
export const DIFF_ADDED_BAND = '#1e3d24'

/** The band a changed run sits on inside a removed line; the pair of {@link DIFF_ADDED_BAND}. */
export const DIFF_REMOVED_BAND = '#472424'

/**
 * The shade the frame around an assistant reply is drawn in.
 *
 * A reply is boxed so one exchange reads as two objects rather than as a box and
 * then a stream, and its frame must not be mistaken for the bar the reader types
 * into: a warm gold sits apart from the prompt's mint and the brand-blue editor,
 * without borrowing the warning amber that means a state.
 */
export const ASSISTANT_FRAME_GOLD = '#d6c29a'

/** The colours a token can name, so a shade is changed in one place. */
export const DEFAULT_PALETTE: Readonly<Record<PaletteName, string>> = {
  default: '#d0d0d0',
  muted: MUTED_GREY,
  faint: FAINT_GREY,
  accent: '#5fafd7',
  arg: ARGUMENT_BLUE,
  warn: '#d7af5f',
  added: '#5faf5f',
  removed: '#d75f5f',
  user: USER_PROMPT_MINT,
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

/**
 * The reasoning row recedes past the muted family, hence its own entry.
 *
 * Italic is what separates the signpost from the thought it introduces; the
 * darker grey is what makes the thought itself the brightest thing there.
 */
const signpost: StyleSpec = { fg: 'faint', italic: true }

/**
 * A thought shares the signpost's shade but not its slant.
 *
 * The body is read rather than scanned, so it keeps an upright face while the
 * row naming it stays italic; one shade for both is what makes a thought read
 * as one element instead of two colours arguing.
 */
const thought: StyleSpec = { fg: 'faint' }
const plain: StyleSpec = {}

/**
 * The shipped appearance of every token.
 *
 * Defaults reproduce the surface as it looked before tokens existed, except the
 * muted family, which moves from faint-on-a-palette-slot to an explicit grey.
 * A test asserts every token in {@link TUI_TOKENS} appears here.
 */
export const DEFAULT_TOKENS: Readonly<Record<TuiToken, StyleSpec>> = {
  'transcript.user': { fg: 'user' },
  'transcript.user.border': muted,
  'transcript.assistant.border': { fg: ASSISTANT_FRAME_GOLD },
  'transcript.notice': muted,
  'transcript.marker': muted,
  'transcript.reasoning.summary': signpost,
  'transcript.reasoning.body': thought,
  'transcript.reasoning.hint': signpost,

  // The tool's own name is not a state: a running call is the one painted in the
  // running colour, so the name it wears when nothing is happening has to be a
  // colour of its own.
  'tool.title': { fg: 'accent' },
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
  'tool.running.title': { fg: 'warn' },
  'tool.running.elapsed': { fg: 'warn' },
  // Quiet and slanted: a measurement of something already over must not read as
  // loudly as the facts the result reported.
  'tool.elapsed.done': { fg: 'muted', italic: true },
  'tool.subcall.title': muted,
  'tool.subcall.running': { fg: 'warn' },
  'tool.subcall.args': { fg: 'arg' },

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
  // A diff's scaffolding recedes the way a card's does, and its unchanged code
  // keeps the plain shade a fence already had, so a reply without a diff fence
  // draws exactly as it did.
  'markdown.diff.header': muted,
  'markdown.diff.hunk': muted,
  'markdown.diff.context': plain,
  'markdown.diff.added': { fg: 'added' },
  'markdown.diff.removed': { fg: 'removed' },
  // The band is the emphasis and the foreground is inherited from the row, so a
  // palette move carries both without the reader restating either.
  'markdown.diff.addedEmphasis': { inherit: 'markdown.diff.added', bg: DIFF_ADDED_BAND },
  'markdown.diff.removedEmphasis': { inherit: 'markdown.diff.removed', bg: DIFF_REMOVED_BAND },
  'markdown.diagram.border': muted,
  'markdown.diagram.text': plain,
  'markdown.diagram.edge': { fg: 'accent' },
  'markdown.diagram.edgeLabel': muted,
  'markdown.diagram.title': { fg: 'accent', bold: true },
  'markdown.diagram.warning': { fg: 'warn' },

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
  'picker.border': muted,

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
  // Each section's rule carries that section's own hue, so which list a row
  // belongs to is read off the edge of it rather than off the row itself: the
  // rows keep the muted family that lets a long command stay legible.
  'dock.todos.border': { fg: 'accent' },
  'dock.todos.heading': { bold: true },
  'dock.todos.pending': muted,
  'dock.todos.inProgress': muted,
  'dock.todos.overflow': muted,
  'dock.subagents.border': { fg: 'user' },
  'dock.subagents.heading': { bold: true },
  'dock.subagents.running': muted,
  'dock.subagents.overflow': muted,
  'dock.jobs.border': { fg: 'warn' },
  'dock.jobs.heading': { bold: true },
  'dock.jobs.running': muted,
  'dock.jobs.overflow': muted,

  'status.prefix': { fg: 'accent' },
  // The way back is a key the reader presses, so it carries the weight of an
  // armed chord rather than toning down with the facts.
  'status.back': { fg: 'accent' },
  'status.activity.working': muted,
  'status.activity.ready': muted,
  'status.elapsed': muted,
  'status.agentPreset': muted,
  'status.model': muted,
  'status.effort': muted,
  'status.permission': muted,
  'status.context': muted,
  'status.cache': muted,
  // Accented, unlike the facts around it: a parked draft is something the
  // reader left behind and may want back, not another measurement.
  'status.stash': { fg: 'accent' },
  'status.cwd': muted,
  'status.separator': muted,

  'editor.border': muted,
  // No colour: a faint is dropped the moment a colour is named, and faint is
  // what makes queued text read as not-yet-sent rather than as being typed.
  'editor.queued': { dim: true, italic: true },
  'editor.queued.more': muted,
  // Faint only: the ghost is a suggestion, and a named colour would drop the
  // faint that makes it read as not-yet-typed.
  'editor.ghost': { dim: true },
  'editor.selectList.selectedPrefix': { fg: 'accent' },
  'editor.selectList.selectedText': { bold: true },
  'editor.selectList.description': muted,
  'editor.selectList.scrollInfo': muted,
  'editor.selectList.noMatch': muted,
}
