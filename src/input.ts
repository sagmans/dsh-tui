/**
 * Decoding shared by every surface that reads typed text.
 *
 * The terminal reports a paste as one bracketed run rather than as key presses,
 * so a handler that only knows single characters silently drops what a reader
 * copied; unwrapping it here keeps each surface answering for its own meaning
 * instead of each re-deriving the same markers.
 */

/** The markers the surface wraps a paste in once the terminal reports one. */
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

/**
 * The text a bracketed paste carries, or undefined when the input is a key press.
 *
 * Control bytes are the terminal's, not the reader's: a copied key arrives with
 * the newline that copied it, and keeping that newline would confirm a question
 * before the reader saw what landed.
 */
export function pastedText(data: string): string | undefined {
  const start = data.indexOf(PASTE_START)
  if (start === -1) return undefined
  const rest = data.slice(start + PASTE_START.length)
  const end = rest.indexOf(PASTE_END)
  return (end === -1 ? rest : rest.slice(0, end)).replace(/[\u0000-\u001f\u007f]/gu, '')
}
