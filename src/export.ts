import { rowText } from './cards.ts'
import { displayText } from './text.ts'
import type { TranscriptEntry } from './transcript.ts'

/** Directory-relative default the reader can find without being told. */
export const DEFAULT_EXPORT_PREFIX = 'dsh-session'

/** How the dump marks a nested call that returned an error, which the screen carried as colour. */
const SUBCALL_FAILED_SUFFIX = ' (failed)'

/** Id characters kept in a file name, so a session id cannot escape the directory. */
const UNSAFE_NAME = /[^A-Za-z0-9._-]/gu

/** The shortest code fence; a longer backtick run in the body needs a longer one. */
const MIN_FENCE = 3
const BACKTICK_RUN = /`+/gu
/** A comment body must not close the comment that carries it. */
const COMMENT_CLOSE = '-->'
const COMMENT_CLOSE_DEFUSED = '--&gt;'

/** Default file for a dump: the session's own name, in the working directory. */
export function defaultExportFile(sessionId: string): string {
  return `${DEFAULT_EXPORT_PREFIX}-${sessionId.replace(UNSAFE_NAME, '_')}.md`
}

/**
 * A fence the body cannot close early.
 *
 * Tool output and thinking are arbitrary text, and a run of three backticks in
 * either would end the block and spill the rest into the document as prose.
 */
function fenceFor(text: string): string {
  let longest = 0
  for (const run of text.match(BACKTICK_RUN) ?? []) longest = Math.max(longest, run.length)
  return '`'.repeat(Math.max(MIN_FENCE, longest + 1))
}

/** Comment text with any closing marker defused, so the comment stays one. */
function commentBody(text: string): string {
  return displayText(text).replaceAll(COMMENT_CLOSE, COMMENT_CLOSE_DEFUSED)
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
        lines.push('', `<!-- ${commentBody(entry.text)} -->`)
        break
      case 'marker':
        lines.push('', `--- ${displayText(entry.text)} ---`)
        break
      case 'reasoning': {
        // The thought is on screen now, so it belongs in the dump; only the
        // count is metadata, and the body is the part a reader came for.
        const body = entry.body.split('\n').map(line => displayText(line))
        const fence = fenceFor(body.join('\n'))
        lines.push('', `<!-- ${commentBody(entry.summary)} -->`, `${fence}reasoning`)
        lines.push(...body)
        lines.push(fence)
        break
      }
      case 'tool': {
        const mark = entry.card.failed ? 'ERROR' : 'tool'
        // The dump is the words, not the screen: row classes exist so the
        // surface can style a line, and a file has no use for them.
        const rows = entry.card.detail.map(row => displayText(rowText(row)))
        const more = entry.card.totalLines > entry.card.detail.length
          ? `… ${entry.card.totalLines - entry.card.detail.length} more lines`
          : undefined
        const fence = fenceFor([displayText(entry.card.title), ...rows, more ?? ''].join('\n'))
        lines.push('', `### ${mark}: ${displayText(entry.card.title)}`)
        // The calls are what the reader saw under the card, so a dump that
        // dropped them would lose the only record of what the program reached.
        const subCalls = entry.card.subCalls ?? []
        for (const call of subCalls) {
          const text = call.argument === undefined ? call.title : `${call.title} ${call.argument}`
          lines.push(`- ${displayText(text)}${call.failed ? SUBCALL_FAILED_SUFFIX : ''}`)
        }
        const dropped = (entry.card.subCallsTotal ?? subCalls.length) - subCalls.length
        if (dropped > 0) lines.push(`- … ${dropped} more calls`)
        lines.push('', fence)
        lines.push(...rows)
        if (more !== undefined) lines.push(more)
        lines.push(fence)
        break
      }
    }
  }
  return `${lines.join('\n').replace(/^\n+/u, '')}\n`
}
