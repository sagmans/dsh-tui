/**
 * Clipboard writes.
 *
 * OSC 52 is the only clipboard a terminal program has: it asks the terminal to
 * put text on the reader's clipboard, and it works over SSH, where no local
 * clipboard API exists. The payload is base64 by design, so no control
 * character in the copied text can end the sequence early.
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
