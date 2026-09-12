import type { EditorTheme, MarkdownTheme, SelectListTheme } from '@earendil-works/pi-tui'
import { detectColourMode, type ColourMode } from './theme-capability.ts'
import { DEFAULT_PALETTE, DEFAULT_TOKENS, resolveToken, type ResolvedStyle, type TuiToken } from './theme-tokens.ts'
import type { ThemeOverrides } from './theme-settings.ts'

/** What a caller gets when it has written no settings at all. */
const NO_OVERRIDES: ThemeOverrides = { palette: DEFAULT_PALETTE, tokens: new Map() }

/**
 * Styling the surface applies, and the editor/select themes pi-tui needs.
 *
 * Every element is drawn by naming its token, so a reader's override reaches
 * it without the renderer knowing what the element is for.
 */
export interface TuiTheme {
  readonly color: boolean
  /** Draw one named element. */
  style(token: TuiToken, text: string): string
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
function editorTheme(style: (token: TuiToken, text: string) => string): EditorTheme {
  return {
    borderColor: text => style('editor.border', text),
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
  const resolve = (token: TuiToken): ResolvedStyle => {
    const cached = resolved.get(token)
    if (cached !== undefined) return cached
    const style = resolveToken(token, overrides.tokens, overrides.palette, mode)
    resolved.set(token, style)
    return style
  }
  const style = (token: TuiToken, text: string): string => {
    const { prefix, suffix } = resolve(token)
    return prefix === '' ? text : `${prefix}${text}${suffix}`
  }
  return {
    color: mode !== 'none',
    style,
    glyph: token => resolve(token).glyph,
    visible: token => !resolve(token).hidden,
    editor: editorTheme(style),
    markdown: markdownTheme(style),
  }
}
