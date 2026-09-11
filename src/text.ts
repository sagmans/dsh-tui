/**
 * Make untrusted text safe to hand to a terminal.
 *
 * Model output, tool output, and file content all reach the screen, and a
 * terminal executes the escape sequences it is given: a crafted result could
 * repaint the frame, retitle the window, or write the clipboard. Escaping here,
 * at the one boundary every rendered fragment crosses, means no component has
 * to remember to do it.
 */

const LINE_FEED = 0x0a
const LAST_C0 = 0x1f
const DELETE = 0x7f
const FIRST_C1 = 0x80
const LAST_C1 = 0x9f
const FIRST_SURROGATE = 0xd800
const LAST_SURROGATE = 0xdfff
const REPLACEMENT = '\uFFFD'
const C0_PREFIX = '\\x'
const UNICODE_PREFIX = '\\u'

/** Directional overrides and isolates can reorder the frame around a payload. */
const BIDI_CONTROLS = new Set([0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069])

/** Separators that end a line without a line feed. */
const LINE_SEPARATOR = 0x2028
const PARAGRAPH_SEPARATOR = 0x2029

function escapeCode(prefix: string, code: number, digits: number): string {
  return prefix + code.toString(16).toUpperCase().padStart(digits, '0')
}

/**
 * Render control characters as visible escapes, keeping line feeds.
 *
 * A line feed is the only control a renderer already understands; everything
 * else becomes text so the reader can see that it was there instead of the
 * terminal acting on it. Tabs are escaped too: a tab advances the cursor by a
 * stop the layout cannot predict, which would desynchronize wrapping.
 */
export function displayText(raw: string): string {
  let out = ''
  for (const character of raw) {
    const code = character.codePointAt(0) ?? 0
    if (code === LINE_FEED) {
      out += character
      continue
    }
    if (code <= LAST_C0 || code === DELETE || (code >= FIRST_C1 && code <= LAST_C1)) {
      out += escapeCode(C0_PREFIX, code, 2)
      continue
    }
    // A code point in this range is an unpaired half, which no terminal font has.
    if (code >= FIRST_SURROGATE && code <= LAST_SURROGATE) {
      out += REPLACEMENT
      continue
    }
    if (BIDI_CONTROLS.has(code) || code === LINE_SEPARATOR || code === PARAGRAPH_SEPARATOR) {
      out += escapeCode(UNICODE_PREFIX, code, 4)
      continue
    }
    out += character
  }
  return out
}
