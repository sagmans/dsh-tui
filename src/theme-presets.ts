import type { PaletteName, ThemedSpecs } from './theme-tokens.ts'

/**
 * The themes the surface ships, by the name a reader selects one with.
 *
 * A name rather than a file path: the surface has no theme loader to point at
 * one, and a table compiled against the token list cannot drift from it the way
 * a document could.
 */
export const THEME_NAMES = ['shipped', 'violet-orbit'] as const

/** A theme's name, as the settings section and `/theme` spell it. */
export type ThemeName = (typeof THEME_NAMES)[number]

/**
 * The name that puts the reader back on the table the surface ships.
 *
 * An entry rather than the absence of one, because a theme chosen at runtime
 * has to be un-choosable the same way: the settings seam merges a patch, and
 * only a value can travel through one.
 */
export const SHIPPED_THEME: ThemeName = 'shipped'

/**
 * One shipped theme.
 *
 * Both halves are partial because a theme is a layer over the shipped table and
 * not a replacement for it: it names the shades it moves and the elements it
 * draws differently, and everything it says nothing about keeps its default.
 */
export interface ThemePreset {
  /** The shade an element naming this entry takes instead of the shipped one. */
  readonly palette: Readonly<Partial<Record<PaletteName, string>>>
  /** The elements this theme draws its own way, in the shape a resolver takes. */
  readonly tokens: ThemedSpecs
}

/**
 * violet-orbit, brought over from the pi theme of the same name.
 *
 * The two surfaces do not share a vocabulary — pi names a message's background
 * where this one names the transcript row that draws it — so the port keeps
 * pi's shades verbatim and re-applies them here by what an element *is*. Each
 * shade below therefore names the pi key it came from, which is the only thing
 * that makes a later change to either theme reviewable.
 */
const VIOLET_ORBIT: ThemePreset = {
  palette: {
    // Pi's own roles, moved across unchanged: every element that names the
    // palette rather than a literal follows the theme without being listed.
    default: '#e8e9ff', // text
    muted: '#9aa0c8', // muted
    faint: '#676d95', // dim
    accent: '#8080ff', // accent
    warn: '#fbbf24', // warning
    added: '#22c55e', // success
    removed: '#ef4444', // error
    user: '#f0f1ff', // userMessageText
    assistant: '#e8e9ff', // text
    // Pi has no argument colour of its own, and its link blue — the shade that
    // first came over — shares a family with the label pi gives a tool name, so
    // the two halves of one row could not be told apart. Lifting the argument
    // towards the theme's own violet separates them without leaving the hue.
    arg: '#d2c9f0',
  },
  tokens: {
    // A reader's own turn. Pi fills the row, but this surface already frames it,
    // and a band inside that frame treats one fact twice: it reads as a selected
    // row rather than as the reader's own words. The shade carries over alone.
    'transcript.user': { fg: 'user' }, // userMessageText

    // A tool's label. Pi draws it periwinkle rather than this surface's amber,
    // which is the single change that moves the card family into the theme.
    'tool.title': { fg: '#8197f7' }, // toolTitle
    'tool.glyph': { fg: '#8197f7' }, // toolTitle

    // Card bodies. Pi draws a call's output near the body text rather than
    // muted; keeping that is what makes the theme read as high-contrast.
    'tool.read.line': { fg: '#d6d8f5' }, // toolDiffText
    'tool.terminal.output': { fg: '#d6d8f5' }, // toolOutput
    'tool.generic.detail': { fg: '#d6d8f5' }, // toolOutput
    // Context lines and numbering recede, as they do in pi.
    'tool.diff.hunk': { fg: '#8b90b8' }, // toolDiffContext
    'tool.read.lineNumber': { fg: '#6f759d' }, // syntaxComment
    'tool.search.lineNumber': { fg: '#6f759d' }, // syntaxComment
    // A search hit is the one row the reader is scanning for, and pi gives that
    // "find me" job to its inline-code amber.
    'tool.search.match': { fg: '#fb9e24' }, // mdCode
    // Pi's shell mode is its own shade, and this surface's cwd is the same fact.
    'tool.terminal.cwd': { fg: '#99f6e4' }, // bashMode
    'tool.web.url': { fg: '#93c5fd' }, // mdLink

    'markdown.heading': { fg: '#b5b5ff', bold: true }, // mdHeading
    'markdown.link': { fg: '#93c5fd', underline: true }, // mdLink
    'markdown.linkUrl': { fg: '#7dd3fc' }, // mdLinkUrl
    'markdown.code': { fg: '#fb9e24' }, // mdCode
    'markdown.codeBlock': { fg: '#e3e5ff' }, // mdCodeBlock
    'markdown.codeBlockBorder': { fg: '#4a4d76' }, // mdCodeBlockBorder
    'markdown.quote': { fg: '#c7c9e8' }, // mdQuote
    'markdown.quoteBorder': { fg: '#777bff' }, // mdQuoteBorder
    'markdown.hr': { fg: '#3c3f61' }, // mdHr
    'markdown.listBullet': { fg: '#a5b4fc' }, // mdListBullet
    'markdown.diagram.border': { fg: '#343652' }, // border
    'markdown.diagram.text': { fg: '#e3e5ff' }, // mdCodeBlock
    'markdown.diagram.edge': { fg: 'accent' },
    'markdown.diagram.title': { fg: '#b5b5ff', bold: true }, // mdHeading

    // The current row of a list is a violet band in pi, not a bold row.
    'picker.title': { fg: 'accent', bold: true },
    'picker.glyph': { fg: 'accent', bold: true },
    'picker.note': { fg: '#a7a7ff', bold: true }, // customMessageLabel
    'picker.rowCurrent': { fg: '#a7a7ff', bold: true, bg: '#2e315c' }, // customMessageLabel, selectedBg
    'picker.cursor': { fg: 'accent' },
    'picker.border': { fg: '#343652' }, // border

    'gate.title': { fg: '#b5b5ff', bold: true }, // mdHeading
    // A gate is the one place the surface stops the reader, so the two glyphs
    // take pi's warning and accent rather than the shipped default weight.
    'gate.glyphApproval': { fg: 'warn', bold: true },
    'gate.glyphQuestion': { fg: 'accent', bold: true },
    'gate.optionCurrent': { fg: '#a7a7ff', bold: true, bg: '#2e315c' }, // selectedBg
    'gate.cursor': { fg: 'accent' },

    'dock.goal': { fg: 'accent', bold: true },
    'dock.planMode': { fg: '#a7a7ff', bold: true }, // customMessageLabel
    'dock.todos.heading': { fg: '#b5b5ff', bold: true }, // mdHeading
    'dock.todos.inProgress': { fg: 'accent' },
    'dock.subagents.heading': { fg: '#b5b5ff', bold: true }, // mdHeading
    'dock.jobs.heading': { fg: '#b5b5ff', bold: true }, // mdHeading

    // Pi has no status bar, so this row is an adaptation: its facts stay muted,
    // and the two that are not facts — busy, and a draft left behind — take the
    // amber pi reserves for "look here" and the accent.
    'status.activity.working': { fg: 'warn' },
    // Pi draws its borders a shade above its background, which is what a
    // separator between facts is; the shipped muted grey reads as a fact itself.
    'status.separator': { fg: '#343652' }, // border

    // The editor is the one element that always holds the reader's attention,
    // so it takes pi's focused border rather than its resting one.
    'editor.border': { fg: '#8a8aff' }, // borderAccent
    'editor.queued': { fg: 'faint', italic: true },
    'editor.queued.more': { fg: 'faint' },
    'editor.selectList.selectedText': { fg: '#a7a7ff', bold: true, bg: '#2e315c' }, // selectedBg
    'editor.selectList.description': { fg: 'faint' },
    'editor.selectList.scrollInfo': { fg: 'faint' },
    'editor.selectList.noMatch': { fg: 'faint' },
  },
}

/**
 * The themes a reader can name, by name.
 *
 * `shipped` is the identity layer rather than a special case at every call
 * site: a reader who chose a theme at runtime returns to the default table by
 * choosing this one, through the same write that chose the other.
 */
export const THEME_PRESETS: Readonly<Record<ThemeName, ThemePreset>> = {
  shipped: { palette: {}, tokens: {} },
  'violet-orbit': VIOLET_ORBIT,
}

/**
 * The elements a named theme draws its own way.
 *
 * The lookup lives here rather than at each resolver so a caller cannot apply a
 * theme's palette while forgetting its per-element half, which would draw a
 * half-themed screen that looks like a bug in the theme.
 */
export function presetTokens(name: ThemeName | undefined): ThemedSpecs | undefined {
  return name === undefined ? undefined : THEME_PRESETS[name].tokens
}

/** Whether a name the reader typed is one the surface ships. */
export function isThemeName(name: string): name is ThemeName {
  return (THEME_NAMES as readonly string[]).includes(name)
}
