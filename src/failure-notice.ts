/**
 * The mark that keeps outside text on screen and out of `/export`.
 *
 * A failure reason, a plugin's answer, job output, and a plan row are text from a
 * provider, a plugin, a file, or the system, so the surface cannot know what they
 * quote. The reader asked to see them, but an export is made to be pasted elsewhere,
 * and a notice is a comment there that a rendered preview hides. A pattern filter is
 * not used, because it can only remove the shapes it already knows.
 *
 * The mark sits inside the string because every layer between a failure and the
 * transcript already forwards and deduplicates strings: a second argument could be
 * dropped on the way without any error, and the reason would reach the export.
 */

/** Private use, so no text a reader wrote is likely to hold it and no font draws it. */
const REASON_MARK = '\uE000'

/**
 * Word a notice so that the screen gets `label` and `body`, and an export gets only `label`.
 *
 * @param label Must be text the surface wrote or the reader chose, because it reaches the export.
 * @param body Outside text, with whatever separates it from the label on screen.
 */
export function labelledNotice(label: string, body: string): string {
  return `${label}${REASON_MARK}${body}`
}

/**
 * Word a failure so that the screen gets `label: reason`, and an export gets only `label`.
 *
 * @param label Must be text the surface wrote or the reader chose, because it reaches the export.
 * @param failure The thrown value, or a reason the caller already chose to show.
 * @param consequence Fixed advice after the reason, which only the screen needs.
 */
export function failureNotice(label: string, failure: unknown, consequence = ''): string {
  const reason = failure instanceof Error ? failure.message : String(failure)
  return labelledNotice(label, `: ${reason}${consequence}`)
}

/**
 * Split a finished notice into what each place may show.
 *
 * The first mark ends the label. A mark that a reason happens to quote is dropped
 * from the screen text and cannot move that end later, so it cannot widen the export.
 */
export function noticeParts(notice: string): { text: string; exportText?: string } {
  const end = notice.indexOf(REASON_MARK)
  if (end < 0) return { text: notice }
  return { text: notice.split(REASON_MARK).join(''), exportText: notice.slice(0, end) }
}
