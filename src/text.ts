/**
 * Make untrusted text safe to hand to a terminal.
 *
 * Model output, tool output, and file content all reach the screen, and a
 * terminal executes the escape sequences it is given: a crafted result could
 * repaint the frame, retitle the window, or write the clipboard. Every drawn
 * fragment crosses one of the two boundaries here: `displayText` spells control
 * characters out, and `terminal-text.ts` draws the safe subset the way the
 * terminal that produced it would have, consuming the rest.
 *
 * Not every fragment is drawn, though: text restored into a live editor is
 * stripped rather than escaped, because the editor has no way to show an escape
 * and the terminal would act on it. `stripControlCharacters` is that boundary.
 */

import { escapeTerminalText, type EscapeTextOptions } from './terminal-text.ts'

/**
 * Render control characters as visible escapes, keeping line feeds.
 *
 * A line feed is the only control a renderer already understands; everything
 * else becomes text so the reader can see that it was there instead of the
 * terminal acting on it. A tab is the exception that is not spelled: it is
 * expanded to the stop the tool that wrote it used, because a stop the layout
 * cannot predict would desynchronize wrapping. Text that is *drawn* is not read
 * this way at all — it goes through `renderTerminalText`, which interprets the
 * sequences a terminal would have interpreted.
 */
export function displayText(raw: string, options?: EscapeTextOptions): string {
  return escapeTerminalText(raw, options)
}

/**
 * The breaks a one-row cut must not carry.
 *
 * A line feed is the one control a renderer understands, so it survives
 * {@link displayText}; a row that kept it would write the rest of itself on the
 * row below, because the alternate screen runs with autowrap off and the break
 * moves the cursor down instead of wrapping. Cutting is where a caller promises
 * a single row, so the flattening happens there.
 */
const ROW_BREAKS = /[\r\n\u2028\u2029]+/gu

/** One row of text: every run of line breaks becomes the space between its rows. */
export function oneRow(text: string): string {
  return text.replace(ROW_BREAKS, ' ')
}

/** Grapheme clusters, the smallest run of text a reader would recognize as one thing. */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * The first `limit` grapheme clusters of text.
 *
 * A budget counted in code points can cut a combining mark, a skin-tone modifier,
 * or a joined emoji away from the cluster it belongs to, leaving half a character
 * on the row. A cluster is the smallest run a cut may keep or drop; counting is
 * still not measuring, so the renderer wraps and cuts by display width after.
 */
export function sliceGraphemes(text: string, limit: number): string {
  if (limit <= 0) return ''
  // Code units are never fewer than clusters, so a short string needs no scan.
  if (text.length <= limit) return text
  const kept: string[] = []
  for (const { segment } of GRAPHEMES.segment(text)) {
    if (kept.length >= limit) break
    kept.push(segment)
  }
  return kept.join('')
}

/**
 * The last `limit` grapheme clusters of text.
 *
 * A live thought grows from the end, so the head is what can be given up; the cut
 * still falls between clusters, because half a character at the top of the row is
 * the same glitch as half a character at the end of it.
 */
export function tailGraphemes(text: string, limit: number): string {
  if (limit <= 0) return ''
  // Code units are never fewer than clusters, so a short string needs no scan.
  if (text.length <= limit) return text
  const clusters: string[] = []
  for (const { segment } of GRAPHEMES.segment(text)) clusters.push(segment)
  return clusters.length <= limit ? text : clusters.slice(-limit).join('')
}

/**
 * Text as the clusters a reader would count.
 *
 * The two cutters above bail out before scanning when the text is shorter than
 * the budget; a caller comparing two pieces of text cluster by cluster — the
 * two sides of an edit, for one — has to see every one of them, and comparing
 * clusters is what keeps a drawn run from ending inside a character.
 */
export function splitGraphemes(text: string): string[] {
  const clusters: string[] = []
  for (const { segment } of GRAPHEMES.segment(text)) clusters.push(segment)
  return clusters
}

/**
 * Control characters text kept for a terminal can never legitimately need:
 * everything below the printable range except the tab and line feed that lay
 * text out, plus DEL, the C1 block, and the bidi overrides.
 *
 * Escaping is what text that is drawn needs; this is for text handed back to a
 * live editor instead — a stashed draft being restored, or a draft returning
 * from the reader's own editor. A sequence that reached either through a
 * hand-edited file would be executed as a command rather than appearing as the
 * text they asked for: clearing the screen, or replacing the clipboard over
 * OSC 52. The bidi overrides go with them because they draw nothing, so they
 * cannot be seen and cannot be removed by hand, and what they reorder is what
 * the reader is about to run; a terminal that shapes right-to-left text still
 * has the letters themselves. A carriage return goes too, so a draft saved with
 * CRLF endings arrives as lines rather than as a control the editor would draw.
 */
const DISALLOWED_CONTROL_CHARACTERS =
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu

/** The form of text that is safe to put back into a live editor. */
export function stripControlCharacters(text: string): string {
  return text.replace(DISALLOWED_CONTROL_CHARACTERS, '')
}
