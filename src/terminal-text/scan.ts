/**
 * The escape grammar the surface recognises, and the visible spelling of the
 * controls it must not execute.
 *
 * Kept apart from the renderer because recognition is the trust boundary: what
 * this module accepts is what every drawing path is handed, and its rules
 * follow the terminal's grammar rather than a row's layout.
 */

export const ESC = '\u001b'

const REPLACEMENT = '\uFFFD'

const C0_PREFIX = '\\x'

const UNICODE_PREFIX = '\\u'

const HEX2 = 2

const HEX4 = 4

const LAST_C0 = 0x1f

const TAB = 0x09

const LINE_FEED = 0x0a

const CARRIAGE_RETURN = 0x0d

const BACKSPACE = 0x08

const DELETE = 0x7f

const FIRST_C1 = 0x80

const LAST_C1 = 0x9f

const FIRST_SURROGATE = 0xd800

const LAST_SURROGATE = 0xdfff

/** The bytes a text fragment cannot be drawn with: they are either sequences to read or marks to spell. */
export const NEEDS_READING = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uD800-\uDFFF]/u

/** Directional overrides and isolates, which reorder a row without drawing anything. */
const BIDI_CONTROLS = new Set([0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069])

const LINE_SEPARATOR = 0x2028

const PARAGRAPH_SEPARATOR = 0x2029

const ARABIC_LETTER_MARK = 0x061c

const LEFT_TO_RIGHT_MARK = 0x200e

const RIGHT_TO_LEFT_MARK = 0x200f

/** The SGR final byte, and the parameter bytes a sequence may carry before it. */
const SGR_FINAL = 'm'

const CSI_PARAMETER_LAST = 0x3f

const CSI_INTERMEDIATE_FIRST = 0x20

const CSI_INTERMEDIATE_LAST = 0x2f

const CSI_FINAL_FIRST = 0x40

const CSI_FINAL_LAST = 0x7e

const ESCAPE_FINAL_FIRST = 0x30

const OSC_INTRODUCER = ']'

const STRING_INTRODUCERS = new Set(['P', 'X', '^', '_'])

const STRING_END = '\u0007'

export const RESET = 0

export type Token =
  | { readonly kind: 'text' }
  | { readonly kind: 'lineFeed' }
  | { readonly kind: 'tab' }
  | { readonly kind: 'carriageReturn' }
  | { readonly kind: 'backspace' }
  | { readonly kind: 'sgr'; readonly params: readonly number[] }
  | { readonly kind: 'consumed' }
  | { readonly kind: 'control' }
  | { readonly kind: 'incomplete' }

/** One recognised piece of the input, with the source text it was read from. */
export interface Piece {
  readonly token: Token
  readonly raw: string
}

function escapeCode(prefix: string, code: number, digits: number): string {
  return prefix + code.toString(16).toUpperCase().padStart(digits, '0')
}

/** Whether a code point is a mark this module spells instead of drawing. */
function isSpelledControl(code: number): boolean {
  if (code <= LAST_C0 || code === DELETE) return true
  if (code >= FIRST_C1 && code <= LAST_C1) return true
  return BIDI_CONTROLS.has(code) || code === LINE_SEPARATOR || code === PARAGRAPH_SEPARATOR || code === ARABIC_LETTER_MARK || code === LEFT_TO_RIGHT_MARK || code === RIGHT_TO_LEFT_MARK
}

function spelled(code: number): string {
  if (code <= 0xff) return escapeCode(C0_PREFIX, code, HEX2)
  return escapeCode(UNICODE_PREFIX, code, HEX4)
}

/** Every character of a sequence that is a control, spelled; the rest of it is printable. */
export function spellControls(raw: string): string {
  let out = ''
  for (const character of raw) {
    const code = character.codePointAt(0) ?? 0
    out += isSpelledControl(code) ? spelled(code) : character
  }
  return out
}

function isCsiFinal(code: number): boolean {
  return code >= CSI_FINAL_FIRST && code <= CSI_FINAL_LAST
}

/**
 * Read one escape sequence at `at`.
 *
 * A string sequence (OSC, DCS, and their siblings) runs to BEL or ST; when its
 * terminator never arrives the sequence is reported incomplete rather than
 * swallowed to the end of the row, because the renderer and the editor want
 * different answers for a truncated sequence and only the scanner knows where
 * it stopped.
 */
function readEscape(raw: string, at: number): Piece | undefined {
  const introducer = raw[at + 1]
  if (introducer === undefined) return undefined
  if (introducer === '[') {
    let end = at + 2
    while (end < raw.length) {
      const code = raw.charCodeAt(end)
      if (isCsiFinal(code)) {
        const source = raw.slice(at, end + 1)
        if (raw[end] === SGR_FINAL) {
          const params = parseSgrParams(source.slice(2, -1))
          if (params !== undefined) return { token: { kind: 'sgr', params }, raw: source }
        }
        return { token: { kind: 'consumed' }, raw: source }
      }
      if (code > CSI_PARAMETER_LAST && (code < CSI_INTERMEDIATE_FIRST || code > CSI_INTERMEDIATE_LAST)) {
        // A byte outside the CSI grammar ends the sequence as malformed; the
        // sequence is consumed so its bytes cannot be drawn as text.
        return { token: { kind: 'consumed' }, raw: raw.slice(at, end) }
      }
      end += 1
    }
    return { token: { kind: 'incomplete' }, raw: raw.slice(at) }
  }
  if (introducer === OSC_INTRODUCER || STRING_INTRODUCERS.has(introducer)) {
    let end = at + 2
    while (end < raw.length) {
      if (raw[end] === STRING_END) return { token: { kind: 'consumed' }, raw: raw.slice(at, end + 1) }
      if (raw[end] === ESC && raw[end + 1] === '\\') return { token: { kind: 'consumed' }, raw: raw.slice(at, end + 2) }
      end += 1
    }
    return { token: { kind: 'incomplete' }, raw: raw.slice(at) }
  }
  const code = raw.charCodeAt(at + 1)
  if (code >= ESCAPE_FINAL_FIRST && code <= CSI_FINAL_LAST) {
    return { token: { kind: 'consumed' }, raw: raw.slice(at, at + 2) }
  }
  return undefined
}

/** The parameters of an SGR sequence, or nothing when it uses a form this module does not model. */
export function parseSgrParams(body: string): readonly number[] | undefined {
  if (body === '') return [RESET]
  const params: number[] = []
  for (const part of body.split(';')) {
    if (!/^[0-9]*$/.test(part)) return undefined
    params.push(part === '' ? RESET : Number(part))
  }
  return params
}

/** Split a text fragment into the pieces a policy draws or spells. */
export function scan(raw: string): Piece[] {
  const pieces: Piece[] = []
  let text = ''
  const flush = (): void => {
    if (text === '') return
    pieces.push({ token: { kind: 'text' }, raw: text })
    text = ''
  }
  let at = 0
  while (at < raw.length) {
    const code = raw.codePointAt(at) ?? 0
    const character = String.fromCodePoint(code)
    if (code === LINE_FEED) {
      flush()
      pieces.push({ token: { kind: 'lineFeed' }, raw: character })
    } else if (code === TAB) {
      flush()
      pieces.push({ token: { kind: 'tab' }, raw: character })
    } else if (code === CARRIAGE_RETURN) {
      flush()
      pieces.push({ token: { kind: 'carriageReturn' }, raw: character })
    } else if (code === BACKSPACE) {
      flush()
      pieces.push({ token: { kind: 'backspace' }, raw: character })
    } else if (code === 0x1b) {
      flush()
      const sequence = readEscape(raw, at)
      if (sequence === undefined) {
        pieces.push({ token: { kind: 'control' }, raw: character })
      } else {
        pieces.push(sequence)
        at += sequence.raw.length
        continue
      }
    } else if (code >= FIRST_SURROGATE && code <= LAST_SURROGATE) {
      text += REPLACEMENT
    } else if (isSpelledControl(code)) {
      flush()
      pieces.push({ token: { kind: 'control' }, raw: character })
    } else {
      text += character
    }
    at += character.length
  }
  flush()
  return pieces
}
