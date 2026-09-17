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

/** Which layer an SGR colour code addresses. */
export type ColourLayer = 'fg' | 'bg'

const HEX = /^#([0-9a-f]{6})$/iu
const MAX_INDEX = 255
const HEX_MAX = 0xff
const CUBE_LEVELS = 5
const MID_GREY = 128

/** The base SGR codes for a layer, normal and bright. */
const FG_NORMAL = 30
const FG_BRIGHT = 90
const BG_NORMAL = 40
const BG_BRIGHT = 100
/** Indices 0-15 are the base slots; above that an index names a 256-colour entry. */
const BASE_COLOURS = 16
const CUBE_BASE = 16
const CUBE_SIDE = 6
const CUBE_SQUARES = 36
const GREY_BASE = 232
const GREY_START = 8
const GREY_STEP = 10
/** The xterm cube is not linear at the dark end, so its six levels are a table. */
const CUBE_RGB = [0, 95, 135, 175, 215, 255] as const

/** The six hue slots of the base palette, by which channel dominates. */
const HUE_RED = 1
const HUE_GREEN = 2
const HUE_YELLOW = 3
const HUE_BLUE = 4
const HUE_MAGENTA = 5
const HUE_CYAN = 6
const WHITE_SLOT = 7
const BRIGHT_BLACK_SLOT = 8
const BRIGHT_WHITE_SLOT = 15

/**
 * A colour this far from grey keeps its hue family when degraded to 16 colours.
 *
 * A luminance average alone sent the muted green additions to black on a dark
 * terminal, which is the failure this threshold exists to prevent.
 */
const GREY_CHROMA = 30
/** Luma boundaries between the four grey slots a degrade may pick. */
const GREY_BLACK_MAX = 64
const GREY_LIGHT_MAX = 160
const GREY_WHITE_MAX = 224

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

/** The SGR code for one of the 16 base slots. */
function slotCode(slot: number, layer: ColourLayer): number {
  const normal = layer === 'fg' ? FG_NORMAL : BG_NORMAL
  const bright = layer === 'fg' ? FG_BRIGHT : BG_BRIGHT
  if (slot >= 0 && slot <= WHITE_SLOT) return normal + slot
  if (slot > WHITE_SLOT && slot <= BRIGHT_WHITE_SLOT) return bright + (slot - 8)
  return normal
}

/** The nearest 256-colour cube index for a triple. */
function cubeIndex(rgb: Rgb): number {
  const level = (value: number): number => Math.round((value / HEX_MAX) * CUBE_LEVELS)
  return 16 + 36 * level(rgb.r) + 6 * level(rgb.g) + level(rgb.b)
}

/** The triple a 256-colour index names, for degradation to the base palette. */
function indexToRgb(index: number): Rgb {
  if (index >= GREY_BASE) {
    const value = GREY_START + (index - GREY_BASE) * GREY_STEP
    return { r: value, g: value, b: value }
  }
  const cube = index - CUBE_BASE
  const top = Math.floor(cube / CUBE_SQUARES)
  const middle = Math.floor((cube % CUBE_SQUARES) / CUBE_SIDE)
  const bottom = cube % CUBE_SIDE
  return {
    r: CUBE_RGB[top] ?? 0,
    g: CUBE_RGB[middle] ?? 0,
    b: CUBE_RGB[bottom] ?? 0,
  }
}

/**
 * The hue slot a non-grey triple belongs to.
 *
 * A secondary channel close to the leading one is the mixed hue (amber, sky,
 * pink), which is why the band exists: without it the amber warning read as
 * plain red on a 16-colour terminal.
 */
function hueSlot(rgb: Rgb): number {
  const max = Math.max(rgb.r, rgb.g, rgb.b)
  const min = Math.min(rgb.r, rgb.g, rgb.b)
  const band = (max - min) / 2
  if (rgb.b === min && Math.abs(rgb.r - rgb.g) < band) return HUE_YELLOW
  if (rgb.r === min && Math.abs(rgb.g - rgb.b) < band) return HUE_CYAN
  if (rgb.g === min && Math.abs(rgb.r - rgb.b) < band) return HUE_MAGENTA
  if (rgb.r === max) return HUE_RED
  if (rgb.g === max) return HUE_GREEN
  return HUE_BLUE
}

/**
 * The nearest base-palette slot for a triple.
 *
 * Greys pick a grey slot, so "recede" survives on a 16-colour terminal, and a
 * colour keeps its hue family so an addition stays green; collapsing both onto
 * black or white is what made the degraded palette unreadable.
 */
function degradeTo16(rgb: Rgb): number {
  const max = Math.max(rgb.r, rgb.g, rgb.b)
  const min = Math.min(rgb.r, rgb.g, rgb.b)
  const level = Math.round((rgb.r + rgb.g + rgb.b) / 3)
  if (max - min < GREY_CHROMA) {
    if (level >= GREY_WHITE_MAX) return BRIGHT_WHITE_SLOT
    if (level >= GREY_LIGHT_MAX) return WHITE_SLOT
    if (level >= GREY_BLACK_MAX) return BRIGHT_BLACK_SLOT
    return 0
  }
  const slot = hueSlot(rgb)
  return level >= MID_GREY ? slot + 8 : slot
}

/** The SGR sequence that starts a colour on one layer, or empty when there is none. */
function colourSgr(spec: string | number, mode: ColourMode, layer: ColourLayer): string {
  if (mode === 'none') return ''
  const parsed = parseColour(spec)
  if (parsed === undefined) return ''
  const extended = layer === 'fg' ? 38 : 48
  if (typeof parsed === 'number') {
    // A base slot is itself a 16-colour code; only a 16-colour terminal has to
    // degrade a 256 entry, and a 24-bit terminal can address it directly.
    if (mode === '16') {
      const slot = parsed < BASE_COLOURS ? parsed : degradeTo16(indexToRgb(parsed))
      return `\u001B[${slotCode(slot, layer)}m`
    }
    return `\u001B[${extended};5;${parsed}m`
  }
  if (mode === 'truecolor') return `\u001B[${extended};2;${parsed.r};${parsed.g};${parsed.b}m`
  if (mode === '256') return `\u001B[${extended};5;${cubeIndex(parsed)}m`
  return `\u001B[${slotCode(degradeTo16(parsed), layer)}m`
}

/**
 * The SGR prefix that starts a foreground colour, or empty when colour is off.
 *
 * Degrading a chosen shade to the nearest available slot keeps the reader's
 * intent on a weaker terminal, which matters more for text that is meant to
 * recede than exactness does.
 */
export function sgrPrefix(spec: string | number, mode: ColourMode): string {
  return colourSgr(spec, mode, 'fg')
}

/** The SGR prefix that starts a background colour, or empty when colour is off. */
export function sgrBackgroundPrefix(spec: string | number, mode: ColourMode): string {
  return colourSgr(spec, mode, 'bg')
}
