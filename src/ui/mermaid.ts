import { Marked, type Token } from '@earendil-works/pi-tui'
import { render, type MermaidArt, type Role } from 'lovely-mermaid'
import type { MermaidMode } from '../theme-settings.ts'
import type { TuiToken } from '../theme-tokens.ts'
import type { TuiTheme } from '../theme.ts'

/** The one fence language that asks for a drawing. */
const MERMAID_FENCE_LANG = 'mermaid'

/** The cheap guard before lexing; case-insensitive because a fence may shout. */
const MERMAID_MENTION = /mermaid/iu

/** Drawings kept before the oldest is laid out again; a streaming reply redraws per delta. */
export const MERMAID_CACHE_LIMIT = 32

/** What ends a row without starting a paragraph; two trailing spaces are CommonMark's hard break. */
const HARD_BREAK = '  \n'

/** An empty code span has no height, so a blank row stands on a non-breaking space. */
const BLANK_ROW = '\u00a0'

const WARNING_LEAD = 'Mermaid diagram not rendered: '
const WARNING_MORE = ' (+'

/** A backtick run inside a row needs a longer delimiter, and a row may hold one inside a label. */
const BACKTICK_RUN = /`+/gu

/**
 * Which element each run of a drawing is, as the token that draws it.
 *
 * The renderer reports what a run *is* and never a colour, so this table is the
 * only place that relates a diagram to the theme; everything else works with
 * roles. Author-assigned classes are deliberately not consulted: a reader's
 * theme is the surface's, not the diagram's.
 */
const ROLE_TOKEN: Readonly<Record<Exclude<Role, 'none'>, TuiToken>> = {
  border: 'markdown.diagram.border',
  text: 'markdown.diagram.text',
  edge: 'markdown.diagram.edge',
  edgeLabel: 'markdown.diagram.edgeLabel',
  title: 'markdown.diagram.title',
}

export interface MermaidOptions {
  readonly theme: TuiTheme
  /** Read per render, so a settings edit reaches a session that is already on screen. */
  readonly mode: () => MermaidMode
}

/**
 * Rewrite one message's markdown, with `live` telling a streaming reply from a settled one.
 *
 * The width is the columns the message actually has, and a drawing that needs
 * more than that is left as source rather than truncated: a mutilated diagram
 * is worse than the text a reader can still read.
 */
export type MermaidTransform = (markdown: string, availableWidth: number, live: boolean) => string

function isMermaidFence(token: Token): token is Token & { type: 'code'; text: string; lang?: string } {
  // The info string may carry more than the language, and a fence may shout.
  return token.type === 'code' && token.lang?.trim().split(/\s+/, 1)[0]?.toLowerCase() === MERMAID_FENCE_LANG
}

/** One drawing row as the code span that keeps its spacing. */
function codeSpan(row: string): string {
  const content = row === '' ? BLANK_ROW : row
  const longest = Math.max(0, ...Array.from(content.matchAll(BACKTICK_RUN), match => match[0].length))
  const fence = '`'.repeat(longest + 1)
  // A row that starts or ends with a backtick would otherwise be read as the delimiter itself.
  const padding = content.startsWith('`') || content.endsWith('`') ? ' ' : ''
  return `${fence}${padding}${content}${padding}${fence}`
}

function warningText(art: MermaidArt): string {
  const first = art.warnings[0] ?? ''
  const rest = art.warnings.length - 1
  return `${WARNING_LEAD}${first}${rest > 0 ? `${WARNING_MORE}${rest} more)` : ''}`
}

/**
 * Lay out each distinct source once.
 *
 * A streaming reply asks for the same fences again on every delta, and laying
 * out a diagram is the expensive half of drawing it; the other half is styling
 * runs, which stays per call so a theme swap needs no invalidation.
 */
function artCache(): (source: string) => MermaidArt | null {
  const drawn = new Map<string, MermaidArt | null>()
  return source => {
    if (drawn.has(source)) return drawn.get(source) ?? null
    const art = render(source)
    if (drawn.size >= MERMAID_CACHE_LIMIT) {
      const oldest = drawn.keys().next()
      if (oldest.done !== true) drawn.delete(oldest.value)
    }
    drawn.set(source, art)
    return art
  }
}

/**
 * Draw a reply's mermaid fences as terminal art.
 *
 * A fence is replaced before the markdown is parsed, because that is the only
 * moment the source is still whole: once tokens are flowing the drawing's rows
 * would be re-wrapped as prose and lose the spacing they are made of. Each row
 * is therefore emitted as an inline code span, which the markdown renderer
 * keeps verbatim, and rows are separated by hard breaks so a diagram survives
 * as one block instead of one paragraph.
 */

export function createMermaidTransform(options: MermaidOptions): MermaidTransform {
  const parser = new Marked()
  const draw = artCache()
  return (markdown, availableWidth, live) => {
    const mode = options.mode()
    // A reply that is still arriving is only drawn in streaming mode; the other
    // modes wait for the settled text, which is also the only text whose losses
    // are worth reporting.
    if (mode === 'off' || (live && mode !== 'streaming')) return markdown
    // Lexing is the cost this guard avoids: no fence can be present without the word.
    if (!MERMAID_MENTION.test(markdown)) return markdown
    return parser
      .lexer(markdown)
      .map(token => {
        if (!isMermaidFence(token)) return token.raw
        const art = draw(token.text)
        if (art === null || art.width > availableWidth) return token.raw
        if (!live && art.warnings.length > 0) {
          return `${token.raw}\n${codeSpan(options.theme.style('markdown.diagram.warning', warningText(art)))}${HARD_BREAK}`
        }
        const rows = art.styled.map(row =>
          row
            .map(span => (span.role === 'none' ? span.text : options.theme.style(ROLE_TOKEN[span.role], span.text)))
            .join(''),
        )
        return `${rows.map(codeSpan).join(HARD_BREAK)}\n`
      })
      .join('')
  }
}
