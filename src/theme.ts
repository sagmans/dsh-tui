import type { EditorTheme, SelectListTheme } from '@earendil-works/pi-tui'

const RESET = '\u001B[0m'

function sgr(code: string, enabled: boolean): (text: string) => string {
  return enabled ? text => `\u001B[${code}m${text}${RESET}` : text => text
}

/** Glyph that introduces each transcript row kind. */
export interface TranscriptGlyphs {
  readonly user: string
  readonly assistant: string
  readonly tool: string
  readonly notice: string
  readonly reasoning: string
}

/** Styling the surface applies, and the editor/select themes pi-tui needs. */
export interface TuiTheme {
  readonly color: boolean
  readonly glyphs: TranscriptGlyphs
  dim(text: string): string
  bold(text: string): string
  tool(text: string): string
  notice(text: string): string
  /** Diff additions and removals, colored by background rather than by hue alone. */
  added(text: string): string
  removed(text: string): string
  readonly editor: EditorTheme
}

function selectListTheme(dim: (t: string) => string, accent: (t: string) => string, bold: (t: string) => string): SelectListTheme {
  return {
    selectedPrefix: accent,
    selectedText: bold,
    description: dim,
    scrollInfo: dim,
    noMatch: dim,
  }
}

/**
 * Build the surface theme.
 *
 * Styling uses the standard 16 ANSI colors and terminal defaults rather than
 * true-color values, so a light or dark terminal remaps the interface on its
 * own and the surface needs no theme setting.
 */
export function createTheme(color: boolean): TuiTheme {
  const dim = sgr('2', color)
  const bold = sgr('1', color)
  const accent = sgr('36', color)
  const warn = sgr('33', color)
  const added = sgr('32', color)
  const removed = sgr('31', color)
  const select = selectListTheme(dim, accent, bold)
  return {
    color,
    glyphs: { user: '›', assistant: '⏺', tool: '⚒', notice: '·', reasoning: '▸' },
    dim,
    bold,
    tool: warn,
    notice: dim,
    added,
    removed,
    editor: { borderColor: dim, selectList: select },
  }
}
