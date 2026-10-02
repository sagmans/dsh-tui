/**
 * Decoding shared by every surface that reads typed text.
 *
 * The terminal reports a paste as one bracketed run rather than as key presses,
 * so a handler that only knows single characters silently drops what a reader
 * copied; unwrapping it here keeps each surface answering for its own meaning
 * instead of each re-deriving the same markers.
 */

import { decodeKittyPrintable, isKeyRelease } from '@earendil-works/pi-tui'

const KEY_SEQUENCE_START = '\x1b['
const PRINTABLE_TEXT = /^[^\u0000-\u001f\u007f-\u009f]+$/u
/** Paste filters share the typed-text policy, so terminal controls cannot become invisible search characters. */
const PASTE_CONTROL_BYTES = /[\u0000-\u001f\u007f-\u009f]/gu
// Kitty reserves this area for functional keys, not printable filter characters.
const KITTY_FUNCTIONAL_TEXT = /^[\ue000-\uf8ff]$/u
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

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
  const text = (end === -1 ? rest : rest.slice(0, end)).replace(PASTE_CONTROL_BYTES, '')
  return text.isWellFormed() ? text : undefined
}

/** A release must not confirm a gate, move a cursor, or insert a second copy of a key. */
export function releasedKey(data: string): boolean {
  return data.startsWith(KEY_SEQUENCE_START) && isKeyRelease(data)
}

/** Shared decoding keeps custom filters consistent with the editor's terminal protocol. */
export function typedText(data: string): string | undefined {
  const paste = pastedText(data)
  if (paste !== undefined) return paste
  if (releasedKey(data)) return undefined
  const decoded = decodeKittyPrintable(data)
  if (decoded !== undefined && KITTY_FUNCTIONAL_TEXT.test(decoded)) return undefined
  const text = decoded ?? data
  return text.isWellFormed() && PRINTABLE_TEXT.test(text) ? text : undefined
}

/** UTF-16 deletion tears emoji and combining sequences into characters the reader never typed. */
export function deleteLastGrapheme(text: string): string {
  let last = 0
  for (const grapheme of GRAPHEMES.segment(text)) last = grapheme.index
  return text.slice(0, last)
}
