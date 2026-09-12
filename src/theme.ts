import type { EditorTheme, MarkdownTheme, SelectListTheme } from '@earendil-works/pi-tui'
import type { TuiToken } from './theme-tokens.ts'

const RESET = '\u001B[0m'

/**
 * Faint, plus the grey half of the standard palette.
 *
 * Faint alone is what "dim" means in the standard, but it is the attribute
 * terminals most often ignore or render as ordinary text, which silently loses
 * the contrast secondary text — the model's reasoning above all — depends on.
 * Bright black is the reliable half of the pair and stays inside the 16-color
 * promise, so a terminal remaps it with its own palette either way.
 */
const DIM_CODES = '2;90'

function sgr(code: string, enabled: boolean): (text: string) => string {
  return enabled ? text => `\u001B[${code}m${text}${RESET}` : text => text
}

/** Styling the surface applies, and the editor/select themes pi-tui needs. */
export interface TuiTheme {
  readonly color: boolean
  dim(text: string): string
  bold(text: string): string
  tool(text: string): string
  notice(text: string): string
  /** Diff additions and removals, colored by background rather than by hue alone. */
  added(text: string): string
  removed(text: string): string
  /** A boundary in the conversation rather than something anyone said. */
  marker(text: string): string
  /** Structure the reader scans for: headings, links, inline code, list bullets. */
  accent(text: string): string
  italic(text: string): string
  /** Draw one named element; the token table owns what each one looks like. */
  style(token: TuiToken, text: string): string
  readonly editor: EditorTheme
  readonly markdown: MarkdownTheme
}

/**
 * The token-to-palette mapping the surface still uses its old helpers for.
 *
 * This is the bridge while renderers move onto tokens one region at a time;
 * the token table takes over the decision once every renderer names a token.
 */
const TOKEN_HELPER: Readonly<Partial<Record<TuiToken, keyof TuiTheme>>> = {
  'transcript.user': 'bold',
  'transcript.notice': 'dim',
  'transcript.marker': 'dim',
  'transcript.reasoning.summary': 'dim',
  'transcript.reasoning.body': 'dim',
  'tool.title': 'tool',
  'tool.failed.title': 'tool',
  'tool.detail': 'dim',
  'tool.diff.added': 'added',
  'tool.diff.removed': 'removed',
}

/**
 * Style markdown through the same palette as the rest of the surface.
 *
 * Code blocks stay unstyled on purpose: a fenced block is already set apart by
 * its border and indentation, and coloring it would fight the reader's own
 * terminal theme.
 */
function markdownTheme(style: {
  readonly dim: (text: string) => string
  readonly bold: (text: string) => string
  readonly accent: (text: string) => string
  readonly italic: (text: string) => string
  readonly underline: (text: string) => string
  readonly strike: (text: string) => string
}): MarkdownTheme {
  return {
    heading: text => style.bold(style.accent(text)),
    link: text => style.underline(style.accent(text)),
    linkUrl: style.dim,
    code: style.accent,
    codeBlock: text => text,
    codeBlockBorder: style.dim,
    quote: style.dim,
    quoteBorder: style.dim,
    hr: style.dim,
    listBullet: style.accent,
    bold: style.bold,
    italic: style.italic,
    strikethrough: style.strike,
    underline: style.underline,
  }
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
 * Whether styling is on, given the launch flag and the environment.
 *
 * `NO_COLOR` is a cross-tool convention (no-color.org): when it is present and
 * not empty, a program that colors by default must not, regardless of its own
 * flags. Honouring it means one environment variable turns styling off for
 * every tool in a session, which is how a reader actually wants it to work.
 */
export function colorEnabled(requested: boolean, env: Record<string, string | undefined> = process.env): boolean {
  const noColor = env.NO_COLOR
  return requested && (noColor === undefined || noColor === '')
}

/**
 * Build the surface theme.
 *
 * Styling uses the standard 16 ANSI colors and terminal defaults rather than
 * true-color values, so a light or dark terminal remaps the interface on its
 * own and the surface needs no theme setting.
 */
export function createTheme(color: boolean): TuiTheme {
  const dim = sgr(DIM_CODES, color)
  const bold = sgr('1', color)
  const accent = sgr('36', color)
  const warn = sgr('33', color)
  const added = sgr('32', color)
  const removed = sgr('31', color)
  const italic = sgr('3', color)
  const underline = sgr('4', color)
  const strike = sgr('9', color)
  const helpers: Record<string, (text: string) => string> = { dim, bold, tool: warn, notice: dim, marker: dim, accent, added, removed, italic }
  return {
    color,
    dim,
    bold,
    tool: warn,
    notice: dim,
    added,
    removed,
    marker: dim,
    accent,
    italic,
    style: (token, text) => {
      const helper = TOKEN_HELPER[token]
      const chosen = helper === undefined ? undefined : helpers[helper]
      // An unmapped token falls back to plain text rather than to an arbitrary
      // style: a wrong colour is worse than no colour while the table is filled.
      return chosen === undefined ? text : chosen(text)
    },
    editor: { borderColor: dim, selectList: selectListTheme(dim, accent, bold) },
    markdown: markdownTheme({ dim, bold, accent, italic, underline, strike }),
  }
}
