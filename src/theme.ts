import { truncateToWidth, type EditorTheme, type MarkdownTheme, type SelectListTheme } from '@earendil-works/pi-tui'
import { oneRow } from './text.ts'
import { renderTerminalText } from './terminal-text.ts'
import { detectColourMode, type ColourMode } from './theme-capability.ts'
import { presetTokens } from './theme-presets.ts'
import { DEFAULT_PALETTE, DEFAULT_TOKENS, resetSequence, resolveToken, type ResolvedStyle, type TuiToken } from './theme-tokens.ts'
import type { ThemeOverrides } from './theme-settings.ts'

/** What a caller gets when it has written no settings at all. */
const NO_OVERRIDES: ThemeOverrides = { palette: DEFAULT_PALETTE, tokens: new Map() }

/**
 * Distinguishes one theme table from the next.
 *
 * A renderer caches rows against the theme that produced them, so the revision
 * is how a cache learns its rows were drawn under a table that is now stale.
 */
let themeRevision = 0

/** What a drawn fragment needs to know: the element it belongs to, and where it starts. */
export interface RichTextOptions {
  /** The element the fragment is drawn inside, whose colour is the ground it returns to. */
  readonly token?: TuiToken
  /** The column the fragment starts at, so its first tab lands on the terminal's next stop. */
  readonly column?: number
}

/**
 * Styling the surface applies, and the editor/select themes pi-tui needs.
 *
 * Every element is drawn by naming its token, so a reader's override reaches
 * it without the renderer knowing what the element is for.
 */
export interface TuiTheme {
  readonly revision: number
  readonly color: boolean
  /** Draw one named element. */
  style(token: TuiToken, text: string): string
  /**
   * Draw text a tool, a model, or a file wrote the way a terminal would have.
   *
   * Unlike {@link style}, the text is not assumed to be the surface's own: its
   * sequences are read, the safe ones are drawn, and the rest are consumed. The
   * named element supplies the ground a foreign reset returns to, so a tool that
   * ends its colour cannot clear the colour the row was drawn in.
   */
  rich(raw: string, options?: RichTextOptions): string
  /** Cut a row to a width, so no renderer has to reach for the raw helper. */
  cut(text: string, width: number, ellipsis?: string): string
  /** The mark that introduces an element, empty unless the reader set one. */
  glyph(token: TuiToken): string
  /** Whether an element is drawn at all. */
  visible(token: TuiToken): boolean
  readonly editor: EditorTheme
  readonly markdown: MarkdownTheme
}

/** Style markdown through the same table as the rest of the surface. */
function markdownTheme(style: (token: TuiToken, text: string) => string): MarkdownTheme {
  return {
    heading: text => style('markdown.heading', text),
    link: text => style('markdown.link', text),
    linkUrl: text => style('markdown.linkUrl', text),
    code: text => style('markdown.code', text),
    codeBlock: text => style('markdown.codeBlock', text),
    codeBlockBorder: text => style('markdown.codeBlockBorder', text),
    quote: text => style('markdown.quote', text),
    quoteBorder: text => style('markdown.quoteBorder', text),
    hr: text => style('markdown.hr', text),
    listBullet: text => style('markdown.listBullet', text),
    bold: text => style('markdown.bold', text),
    italic: text => style('markdown.italic', text),
    strikethrough: text => style('markdown.strikethrough', text),
    underline: text => style('markdown.underline', text),
  }
}

/** The editor keeps only a border colour and a select list, so both come from tokens. */
function editorTheme(
  style: (token: TuiToken, text: string) => string,
  visible: (token: TuiToken) => boolean,
): EditorTheme {
  return {
    // Hiding the border has to remove it: returning the text unstyled would draw
    // it louder than the muted default the reader was trying to remove.
    borderColor: text => (visible('editor.border') ? style('editor.border', text) : ''),
    // A select-list row is framework-owned text, so a hidden entry can only be
    // unstyled rather than absent; the README records that limit.
    selectList: {
      selectedPrefix: text => style('editor.selectList.selectedPrefix', text),
      selectedText: text => style('editor.selectList.selectedText', text),
      description: text => style('editor.selectList.description', text),
      scrollInfo: text => style('editor.selectList.scrollInfo', text),
      noMatch: text => style('editor.selectList.noMatch', text),
    } satisfies SelectListTheme,
  }
}

/**
 * Build the surface theme.
 *
 * Every token is resolved once, when the theme is built, rather than per frame:
 * a repaint walks the whole transcript and re-resolving a palette chain for
 * every row would pay for the same answer thousands of times. A settings change
 * builds a new theme instead, which is also what makes the swap atomic.
 */
export function createTheme(mode: ColourMode = detectColourMode(process.env), overrides: ThemeOverrides = NO_OVERRIDES): TuiTheme {
  const resolved = new Map<TuiToken, ResolvedStyle>()
  // Looked up once: a theme is one layer of every token's answer, not a
  // per-token decision, and a repaint asks for all of them.
  const themed = presetTokens(overrides.preset)
  const resolve = (token: TuiToken): ResolvedStyle => {
    const cached = resolved.get(token)
    if (cached !== undefined) return cached
    const style = resolveToken(token, overrides.tokens, overrides.palette, mode, themed)
    resolved.set(token, style)
    return style
  }
  const style = (token: TuiToken, text: string): string => {
    const { prefix, suffix } = resolve(token)
    return prefix === '' ? text : `${prefix}${text}${suffix}`
  }
  /**
   * Truncate to a width, honouring the promise that `none` emits nothing.
   *
   * pi-tui closes a cut by writing a reset unconditionally, whether or not the
   * text carried any styling, so a truncated row leaks escapes even when
   * colour is off. Those resets close styles this surface never opened, so
   * dropping them restores the contract without changing what is drawn.
   */
  const cut = (text: string, width: number, ellipsis = ''): string => {
    // A row is one row: a break that reached the cut would be written as a move
    // to the next line, over whatever the frame put there.
    const truncated = truncateToWidth(oneRow(text), width, ellipsis)
    return mode === 'none' ? truncated.replaceAll(resetSequence(), '') : truncated
  }
  const visible = (token: TuiToken): boolean => !resolve(token).hidden
  /**
   * Drawn foreign text, with the element's own prefix as its ground.
   *
   * The prefix is passed as the base rather than painted around the result, so
   * the ground a foreign reset restores is the same sequence the row opened
   * with; a hidden element draws nothing at all rather than drawing unstyled,
   * because a reader who removed an element is not asking to see it plainly.
   */
  const rich = (raw: string, options: RichTextOptions = {}): string => {
    const token = options.token
    if (token === undefined) return renderTerminalText(raw, { color: mode, column: options.column })
    const { prefix, suffix, hidden } = resolve(token)
    if (hidden) return ''
    return `${prefix}${renderTerminalText(raw, { color: mode, base: prefix, column: options.column })}${suffix}`
  }
  return {
    revision: ++themeRevision,
    color: mode !== 'none',
    style,
    rich,
    cut,
    glyph: token => resolve(token).glyph,
    visible,
    editor: editorTheme(style, visible),
    markdown: markdownTheme(style),
  }
}

/**
 * An editor theme that follows a moving source.
 *
 * The editor keeps the theme it was built with for the life of the session, so
 * a settings change has to reach it through a stable object instead of by
 * replacing the one it captured.
 */
export function forwardEditorTheme(source: () => EditorTheme): EditorTheme {
  return {
    borderColor: text => source().borderColor(text),
    selectList: {
      selectedPrefix: text => source().selectList.selectedPrefix(text),
      selectedText: text => source().selectList.selectedText(text),
      description: text => source().selectList.description(text),
      scrollInfo: text => source().selectList.scrollInfo(text),
      noMatch: text => source().selectList.noMatch(text),
    } satisfies SelectListTheme,
  }
}

/** The markdown counterpart of {@link forwardEditorTheme}. */
export function forwardMarkdownTheme(source: () => MarkdownTheme): MarkdownTheme {
  return {
    heading: text => source().heading(text),
    link: text => source().link(text),
    linkUrl: text => source().linkUrl(text),
    code: text => source().code(text),
    codeBlock: text => source().codeBlock(text),
    codeBlockBorder: text => source().codeBlockBorder(text),
    quote: text => source().quote(text),
    quoteBorder: text => source().quoteBorder(text),
    hr: text => source().hr(text),
    listBullet: text => source().listBullet(text),
    bold: text => source().bold(text),
    italic: text => source().italic(text),
    strikethrough: text => source().strikethrough(text),
    underline: text => source().underline(text),
  }
}
