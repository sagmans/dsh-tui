/**
 * Terminal text, read the way a terminal would read it.
 *
 * Tool output, file content, and model text all reach the screen, and this
 * module is the only place that decides what a control byte means. It offers
 * two policies over one token stream, so they can never disagree about where a
 * sequence ends:
 *
 * - {@link renderTerminalText} draws what the terminal would have drawn: a
 *   whitelisted SGR subset becomes real colour at the session's colour budget,
 *   a tab lands on its stop, a carriage return repaints the row it sits on, and
 *   every sequence a terminal would *act* on is consumed, so it acts on
 *   nothing. Bytes that are not a sequence are still spelled out rather than
 *   dropped, because silently swallowing text would hide what a tool said.
 * - {@link escapeTerminalText} is for text a buffer or a file will hold: every
 *   control character is spelled out, because an editor cannot draw an escape
 *   and must not execute one.
 *
 * Sharing one scanner matters for more than agreement: pi-tui's own escape
 * scanner recognises less than a terminal does (a `\x1b[?25l` left in a drawn
 * string would make its width arithmetic swallow the text after it), so a
 * sequence that is not SGR must be gone before any width is measured.
 */

import { visibleWidth } from '@earendil-works/pi-tui'
import { sgrBackgroundPrefix, sgrPrefix, type ColourMode } from './theme-capability.ts'

/** Columns between tab stops: the POSIX default, and what every terminal still uses. */
export const TAB_STOP = 8

/** Whether a tab is drawn on its stop, or kept for a buffer that will hold it. */
export type TabPolicy = 'expand' | 'keep'

export interface EscapeTextOptions {
  /** The column the text starts at, so its first tab lands on the terminal's next stop. */
  readonly column?: number | undefined
  readonly tab?: TabPolicy | undefined
}

export interface RenderTextOptions {
  /** The colour budget the session has; `none` drops tool styling entirely. */
  readonly color: ColourMode
  /** SGR already in effect — an element's own colour, which a foreign reset returns to. */
  readonly base?: string | undefined
  readonly column?: number | undefined
}

const ESC = '\u001b'
const CSI = `${ESC}[`
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
const NEEDS_READING = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uD800-\uDFFF]/u

/** Directional overrides and isolates, which reorder a row without drawing anything. */
const BIDI_CONTROLS = new Set([0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069])
const LINE_SEPARATOR = 0x2028
const PARAGRAPH_SEPARATOR = 0x2029
const ARABIC_LETTER_MARK = 0x061c
const LEFT_TO_RIGHT_MARK = 0x200e
const RIGHT_TO_LEFT_MARK = 0x200f

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

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

/** The attributes a run may carry, in the order they are emitted. */
const ATTRIBUTES = ['bold', 'dim', 'italic', 'underline', 'inverse', 'strike'] as const
type Attribute = (typeof ATTRIBUTES)[number]

const ATTRIBUTE_ON: Readonly<Record<Attribute, string>> = {
  bold: `${CSI}1m`,
  dim: `${CSI}2m`,
  italic: `${CSI}3m`,
  underline: `${CSI}4m`,
  inverse: `${CSI}7m`,
  strike: `${CSI}9m`,
}
const ATTRIBUTE_OFF: Readonly<Record<Attribute, string>> = {
  bold: `${CSI}22m`,
  dim: `${CSI}22m`,
  italic: `${CSI}23m`,
  underline: `${CSI}24m`,
  inverse: `${CSI}27m`,
  strike: `${CSI}29m`,
}
const SGR_ATTRIBUTE_ON: Readonly<Record<number, Attribute | undefined>> = { 1: 'bold', 2: 'dim', 3: 'italic', 4: 'underline', 7: 'inverse', 9: 'strike' }
const SGR_ATTRIBUTE_OFF: Readonly<Record<number, readonly Attribute[] | undefined>> = {
  21: ['bold', 'dim'],
  22: ['bold', 'dim'],
  23: ['italic'],
  24: ['underline'],
  27: ['inverse'],
  29: ['strike'],
}
const FIRST_FG_SLOT = 30
const LAST_FG_SLOT = 37
const FIRST_BRIGHT_FG_SLOT = 90
const LAST_BRIGHT_FG_SLOT = 97
const FIRST_BG_SLOT = 40
const LAST_BG_SLOT = 47
const FIRST_BRIGHT_BG_SLOT = 100
const LAST_BRIGHT_BG_SLOT = 107
const FG_DEFAULT = 39
const BG_DEFAULT = 49
const EXTENDED_FG = 38
const EXTENDED_BG = 48
const EXTENDED_INDEXED = 5
const EXTENDED_RGB = 2
const RGB_COMPONENTS = 3
const HEX_PREFIX = '#'
const HEX_PAD = 2
const COLOUR_MAX = 0xff
const BRIGHT_OFFSET = 8
const RESET = 0
const GROUND_FG = `${CSI}${FG_DEFAULT}m`
const GROUND_BG = `${CSI}${BG_DEFAULT}m`

type Token =
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
interface Piece {
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
function spellControls(raw: string): string {
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
function parseSgrParams(body: string): readonly number[] | undefined {
  if (body === '') return [RESET]
  const params: number[] = []
  for (const part of body.split(';')) {
    if (!/^[0-9]*$/.test(part)) return undefined
    params.push(part === '' ? RESET : Number(part))
  }
  return params
}

/** Split a text fragment into the pieces a policy draws or spells. */
function scan(raw: string): Piece[] {
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

/** How many characters a reader sees in this piece, which is what a row budget pays for. */
function visibleLength(piece: Piece): number {
  switch (piece.token.kind) {
    case 'text': {
      let count = 0
      for (const _ of GRAPHEMES.segment(piece.raw)) count += 1
      return count
    }
    case 'sgr':
    case 'consumed':
    case 'incomplete': return 0
    default: return 1
  }
}

/** The next tab stop at or after a column. */
function nextStop(column: number): number {
  return column + TAB_STOP - (column % TAB_STOP)
}

/**
 * Spell every control character, expanding a tab to the stop the terminal would
 * have used.
 *
 * The column is what makes a tab land where it landed for the tool that wrote
 * it: a row indented by four columns reaches its stop four columns later than
 * the same row at the left edge.
 */
export function escapeTerminalText(raw: string, options: EscapeTextOptions = {}): string {
  const tab = options.tab ?? 'expand'
  const expandTabs = tab === 'expand'
  let column = options.column ?? 0
  let out = ''
  for (const piece of scan(raw)) {
    switch (piece.token.kind) {
      case 'text':
        out += piece.raw
        if (expandTabs) column += visibleWidth(piece.raw)
        break
      case 'lineFeed':
        out += '\n'
        column = 0
        break
      case 'tab': {
        if (!expandTabs) {
          out += '\t'
          break
        }
        const stop = nextStop(column)
        out += ' '.repeat(stop - column)
        column = stop
        break
      }
      default: {
        const spelledText = spellControls(piece.raw)
        out += spelledText
        column += spelledText.length
        break
      }
    }
  }
  return out
}

interface TextStyle {
  readonly fg?: string | undefined
  readonly bg?: string | undefined
  /** Attribute bits, so two styles compare by value without walking a set. */
  readonly attributes: number
}

const GROUND: TextStyle = { attributes: 0 }

function withAttributes(style: TextStyle, on: Attribute | undefined, off: readonly Attribute[] | undefined): TextStyle {
  let attributes = style.attributes
  if (off !== undefined) for (const attribute of off) attributes &= ~(1 << ATTRIBUTES.indexOf(attribute))
  if (on !== undefined) attributes |= 1 << ATTRIBUTES.indexOf(on)
  return attributes === style.attributes ? style : { ...style, attributes }
}

function hasAttribute(style: TextStyle, attribute: Attribute): boolean {
  return (style.attributes & (1 << ATTRIBUTES.indexOf(attribute))) !== 0
}

interface Encoder {
  /** The codes that move from one style to the next. */
  between(previous: TextStyle, next: TextStyle): string
}

/**
 * Build the encoder for one colour budget.
 *
 * The element's own colour is the ground state rather than a reset, because a
 * tool that ends a coloured run must not clear the colour the card drew it in;
 * a full reset is never emitted, so nothing outside the run is disturbed.
 */
function encoder(color: ColourMode, base: string): Encoder {
  if (color === 'none') return { between: () => '' }
  const groundCodes = (style: TextStyle): string => {
    let out = ''
    for (const attribute of ATTRIBUTES) if (hasAttribute(style, attribute)) out += ATTRIBUTE_OFF[attribute]
    if (style.fg !== undefined) out += GROUND_FG + base
    if (style.bg !== undefined) out += GROUND_BG + base
    return out
  }
  return {
    between(previous, next) {
      if (previous === next) return ''
      let out = ''
      for (const attribute of ATTRIBUTES) {
        if (hasAttribute(previous, attribute) && !hasAttribute(next, attribute)) out += ATTRIBUTE_OFF[attribute]
      }
      for (const attribute of ATTRIBUTES) {
        if (!hasAttribute(previous, attribute) && hasAttribute(next, attribute)) out += ATTRIBUTE_ON[attribute]
      }
      if (next.fg !== previous.fg) out += next.fg ?? GROUND_FG + base
      if (next.bg !== previous.bg) out += next.bg ?? GROUND_BG + base
      return out
    },
  }
}

function colourFor(params: readonly number[], at: number, color: ColourMode): { readonly code?: string | undefined; readonly next: number } {
  const kind = params[at + 1]
  if (kind === EXTENDED_INDEXED) {
    const index = params[at + 2]
    if (index === undefined) return { next: params.length }
    const code = params[at] === EXTENDED_FG ? sgrPrefix(index, color) : sgrBackgroundPrefix(index, color)
    return { code: code === '' ? undefined : code, next: at + 3 }
  }
  if (kind === EXTENDED_RGB) {
    const r = params[at + 2]
    const g = params[at + 3]
    const b = params[at + 4]
    const spec = r === undefined || g === undefined || b === undefined ? undefined : rgbSpec(r, g, b)
    if (spec === undefined) return { next: at + 2 + RGB_COMPONENTS }
    const code = params[at] === EXTENDED_FG ? sgrPrefix(spec, color) : sgrBackgroundPrefix(spec, color)
    return { code: code === '' ? undefined : code, next: at + 2 + RGB_COMPONENTS }
  }
  return { next: at + 1 }
}

/** Apply an SGR sequence to the state a cell is written with. */
function applySgr(style: TextStyle, params: readonly number[], color: ColourMode): TextStyle {
  let next = style
  let at = 0
  while (at < params.length) {
    const param = params[at] ?? RESET
    if (param === RESET) {
      next = GROUND
      at += 1
      continue
    }
    const on = SGR_ATTRIBUTE_ON[param]
    if (on !== undefined) {
      next = withAttributes(next, on, undefined)
      at += 1
      continue
    }
    const off = SGR_ATTRIBUTE_OFF[param]
    if (off !== undefined) {
      next = withAttributes(next, undefined, off)
      at += 1
      continue
    }
    if (param === EXTENDED_FG || param === EXTENDED_BG) {
      const extended = colourFor(params, at, color)
      if (extended.next <= at) break
      next = extended.code === undefined
        ? { ...next, ...(param === EXTENDED_FG ? { fg: undefined } : { bg: undefined }) }
        : { ...next, ...(param === EXTENDED_FG ? { fg: extended.code } : { bg: extended.code }) }
      at = extended.next
      continue
    }
    if (param >= FIRST_FG_SLOT && param <= LAST_FG_SLOT) {
      next = { ...next, fg: slotColour(param - FIRST_FG_SLOT, color, 'fg') }
    } else if (param >= FIRST_BRIGHT_FG_SLOT && param <= LAST_BRIGHT_FG_SLOT) {
      next = { ...next, fg: slotColour(param - FIRST_BRIGHT_FG_SLOT + BRIGHT_OFFSET, color, 'fg') }
    } else if (param === FG_DEFAULT) {
      next = { ...next, fg: undefined }
    } else if (param >= FIRST_BG_SLOT && param <= LAST_BG_SLOT) {
      next = { ...next, bg: slotColour(param - FIRST_BG_SLOT, color, 'bg') }
    } else if (param >= FIRST_BRIGHT_BG_SLOT && param <= LAST_BRIGHT_BG_SLOT) {
      next = { ...next, bg: slotColour(param - FIRST_BRIGHT_BG_SLOT + BRIGHT_OFFSET, color, 'bg') }
    } else if (param === BG_DEFAULT) {
      next = { ...next, bg: undefined }
    }
    at += 1
  }
  return next
}

/** The hex spec the colour helpers take, or nothing when a tool sent a component a colour cannot hold. */
function rgbSpec(r: number, g: number, b: number): string | undefined {
  for (const value of [r, g, b]) {
    if (!Number.isInteger(value) || value < 0 || value > COLOUR_MAX) return undefined
  }
  return HEX_PREFIX + [r, g, b].map(value => value.toString(16).padStart(HEX_PAD, '0')).join('')
}

function slotColour(slot: number, color: ColourMode, layer: 'fg' | 'bg'): string | undefined {
  const code = layer === 'fg' ? sgrPrefix(slot, color) : sgrBackgroundPrefix(slot, color)
  return code === '' ? undefined : code
}

interface Cell {
  col: number
  width: number
  text: string
  style: TextStyle
}

/**
 * Draw text as the terminal that produced it would have drawn it.
 *
 * A carriage return repaints the row from the column the fragment starts at
 * and a backspace moves one column left, so a progress bar collapses to the
 * state it settled on instead of showing every repaint in a row. That starting
 * column is also a left margin: a row indented by the layout cannot be repainted
 * by the text it holds, which is the one thing a carriage return could
 * otherwise do to the frame. Styling is kept per cell, so what survives a
 * repaint keeps the colour it was written with.
 */
export function renderTerminalText(raw: string, options: RenderTextOptions): string {
  if (!NEEDS_READING.test(raw)) return raw
  const { color, base = '', column = 0 } = options
  const codes = encoder(color, base)
  let style: TextStyle = GROUND
  let previous: TextStyle = GROUND
  let cells: Cell[] = []
  let cursor = column
  let out = ''

  const write = (text: string, width: number): void => {
    if (width === 0) {
      const last = cells[cells.length - 1]
      if (last !== undefined && last.col + last.width === cursor) last.text += text
      return
    }
    cells = cells.filter(cell => cell.col >= cursor + width || cell.col + cell.width <= cursor)
    let at = cells.findIndex(cell => cell.col >= cursor + width)
    if (at < 0) at = cells.length
    cells.splice(at, 0, { col: cursor, width, text, style })
    cursor += width
  }

  const flush = (): void => {
    if (cells.length > 0) {
      let drawn = column
      for (const cell of cells) {
        if (cell.col > drawn) {
          out += codes.between(previous, GROUND)
          previous = GROUND
          out += ' '.repeat(cell.col - drawn)
        }
        out += codes.between(previous, cell.style)
        previous = cell.style
        out += cell.text
        drawn = cell.col + cell.width
      }
    }
    cells = []
    cursor = column
  }

  for (const piece of scan(raw)) {
    switch (piece.token.kind) {
      case 'text':
        for (const { segment } of GRAPHEMES.segment(piece.raw)) write(segment, visibleWidth(segment))
        break
      case 'lineFeed':
        flush()
        out += '\n'
        break
      case 'tab':
        cursor = nextStop(cursor)
        break
      case 'carriageReturn':
        cursor = column
        break
      case 'backspace':
        cursor = Math.max(column, cursor - 1)
        break
      case 'sgr':
        style = applySgr(style, piece.token.params, color)
        break
      case 'control': {
        const mark = spellControls(piece.raw)
        write(mark, mark.length)
        break
      }
      case 'consumed':
      case 'incomplete':
        break
    }
  }
  flush()
  return out
}

/**
 * Cut text to a budget of the characters a reader sees.
 *
 * Sequences are not content: counting them would let a coloured row lose its
 * words sooner than a plain one, and cutting through one would leave a half
 * sequence for a renderer to guess at. The cut falls between grapheme clusters
 * for the same reason every other cut in the surface does — half a joined emoji
 * is the same glitch as half a colour code.
 */
export function clipVisibleGraphemes(raw: string, limit: number): string {
  const pieces = scan(raw)
  let total = 0
  for (const piece of pieces) total += visibleLength(piece)
  if (total <= limit) return raw
  const budget = Math.max(0, limit - 1)
  let kept = 0
  let out = ''
  for (const piece of pieces) {
    if (kept >= budget) break
    if (piece.token.kind === 'text') {
      for (const { segment } of GRAPHEMES.segment(piece.raw)) {
        if (kept >= budget) break
        out += segment
        kept += 1
      }
      continue
    }
    const length = visibleLength(piece)
    if (kept + length > budget) break
    out += piece.raw
    kept += length
  }
  return `${out}…`
}
