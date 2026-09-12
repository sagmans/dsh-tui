import { rowText } from './cards.ts'
import { displayText } from './text.ts'
import type { TranscriptEntry } from './transcript.ts'

/** Directory-relative default the reader can find without being told. */
export const DEFAULT_EXPORT_PREFIX = 'dsh-session'

/** Id characters kept in a file name, so a session id cannot escape the directory. */
const UNSAFE_NAME = /[^A-Za-z0-9._-]/gu

/** Default file for a dump: the session's own name, in the working directory. */
export function defaultExportFile(sessionId: string): string {
  return `${DEFAULT_EXPORT_PREFIX}-${sessionId.replace(UNSAFE_NAME, '_')}.md`
}

/**
 * Render the visible transcript as markdown.
 *
 * The dump outlives the screen it came from, so each row is given the markdown
 * construct that carries its meaning rather than whichever mark the surface
 * happened to draw, and every fragment is escaped for display for the same
 * reason a rendered row is: the file may be opened in a terminal, and it is
 * full of model and tool output.
 */
export function transcriptToText(entries: readonly TranscriptEntry[]): string {
  const lines: string[] = []
  for (const entry of entries) {
    switch (entry.kind) {
      case 'user':
        lines.push('', `> ${displayText(entry.text).replace(/\n/gu, '\n> ')}`)
        break
      case 'assistant':
        lines.push('', displayText(entry.text))
        break
      case 'notice':
        lines.push('', `<!-- ${displayText(entry.text)} -->`)
        break
      case 'marker':
        lines.push('', `--- ${displayText(entry.text)} ---`)
        break
      case 'reasoning':
        lines.push('', `<!-- ${displayText(entry.summary)} -->`)
        break
      case 'tool': {
        const mark = entry.card.failed ? 'ERROR' : 'tool'
        lines.push('', `### ${mark}: ${displayText(entry.card.title)}`, '', '```')
        // The dump is the words, not the screen: row classes exist so the
        // surface can style a line, and a file has no use for them.
        for (const row of entry.card.detail) lines.push(displayText(rowText(row)))
        if (entry.card.totalLines > entry.card.detail.length) {
          lines.push(`… ${entry.card.totalLines - entry.card.detail.length} more lines`)
        }
        lines.push('```')
        break
      }
    }
  }
  return `${lines.join('\n').replace(/^\n+/u, '')}\n`
}
