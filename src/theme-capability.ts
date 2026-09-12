/** How much colour the terminal can be trusted with. */
export type ColourMode = 'truecolor' | '256' | '16' | 'none'

/** An ANSI palette index, 0-255. */
export type AnsiIndex = number

/** An RGB triple. */
export interface Rgb {
  readonly r: number
  readonly g: number
  readonly b: number
}

/** A parsed colour: an RGB triple, or a palette index. */
export type ParsedColour = Rgb | AnsiIndex

const HEX = /^#([0-9a-f]{6})$/iu
const MAX_INDEX = 255
const HEX_MAX = 0xff
const CUBE_LEVELS = 5
const MID_GREY = 128

/**
 * Decide the colour budget from the environment.
 *
 * `NO_COLOR` is the cross-tool convention (no-color.org) and outranks every
 * capability: a reader who set it wants no styling from any tool in the session.
 * `COLORTERM` is what terminals actually set for 24-bit, and `TERM` only proves
 * 256, so truecolor is checked first.
 */
export function detectColourMode(env: Record<string, string | undefined>): ColourMode {
  const noColor = env.NO_COLOR
  if (noColor !== undefined && noColor !== '') return 'none'
  const colorterm = env.COLORTERM ?? ''
  if (colorterm === 'truecolor' || colorterm === '24bit') return 'truecolor'
  if ((env.TERM ?? '').includes('256color')) return '256'
  return '16'
}

/** Parse a colour specification, or `undefined` when it is not one. */
export function parseColour(spec: string | number): ParsedColour | undefined {
  if (typeof spec === 'number') {
    return Number.isInteger(spec) && spec >= 0 && spec <= MAX_INDEX ? spec : undefined
  }
  const match = HEX.exec(spec)
  if (match === null) return undefined
  const value = Number.parseInt(match[1] ?? '', 16)
  return { r: (value >> 16) & HEX_MAX, g: (value >> 8) & HEX_MAX, b: value & HEX_MAX }
}

/** The 16-colour SGR foreground a palette index maps to. */
function ansi16(index: number): number {
  return index < 8 ? 30 + index : 90 + (index - 8)
}

/** The nearest 256-colour cube index for a triple. */
function cubeIndex(rgb: Rgb): number {
  const level = (value: number): number => Math.round((value / HEX_MAX) * CUBE_LEVELS)
  return 16 + 36 * level(rgb.r) + 6 * level(rgb.g) + level(rgb.b)
}

/**
 * The SGR prefix that starts a foreground colour, or empty when colour is off.
 *
 * Degrading a chosen shade to the nearest available index keeps the reader's
 * intent on a weaker terminal, which matters more for text that is meant to
 * recede than exactness does.
 */
export function sgrPrefix(spec: string | number, mode: ColourMode): string {
  if (mode === 'none') return ''
  const parsed = parseColour(spec)
  if (parsed === undefined) return ''
  if (typeof parsed === 'number') {
    return mode === '256' ? `\u001B[38;5;${parsed}m` : `\u001B[${ansi16(parsed)}m`
  }
  if (mode === 'truecolor') return `\u001B[38;2;${parsed.r};${parsed.g};${parsed.b}m`
  if (mode === '256') return `\u001B[38;5;${cubeIndex(parsed)}m`
  // A grey reads as "less important" on either polarity, which is the whole
  // point of the muted half of the palette; hue would be lost at 16 colours.
  const grey = Math.round((parsed.r + parsed.g + parsed.b) / 3)
  return `\u001B[${ansi16(grey < MID_GREY ? 0 : 7)}m`
}
