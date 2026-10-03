/**
 * Clipboard writes.
 *
 * OSC 52 lets the terminal receive copied text over SSH without requiring a
 * clipboard API on the remote host. Base64 keeps copied control characters
 * from ending the sequence early; clipboard access still depends on the
 * terminal accepting the request.
 */

const OSC_INTRODUCER = '\u001b]'
const STRING_TERMINATOR = '\u0007'
const CLIPBOARD_CODE = '52'
/** `c` selects the system clipboard, as opposed to the primary selection. */
const CLIPBOARD_SELECTION = 'c'

/** The sequence that asks the terminal to copy `text`. */
export function clipboardSequence(text: string): string {
  return `${OSC_INTRODUCER}${CLIPBOARD_CODE};${CLIPBOARD_SELECTION};${Buffer.from(text, 'utf8').toString('base64')}${STRING_TERMINATOR}`
}
