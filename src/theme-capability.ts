/** How much colour the terminal can be trusted with. */
export type ColourMode = 'truecolor' | '256' | '16' | 'none'

/** An ANSI palette index, 0-255. */
type AnsiIndex = number

/** An RGB triple. */
interface Rgb {
  readonly r: number
  readonly g: number
  readonly b: number
}

/** Preserve RGB and palette indices separately so capable terminals retain the chosen representation. */
type ParsedColour = Rgb | AnsiIndex

/** Which layer an SGR colour code addresses. */
type ColourLayer = 'fg' | 'bg'

/** Bound palette indices and RGB channels before they become terminal parameters. */
const HEX = /^#([0-9a-f]{6})$/iu
const MAX_INDEX = 255
const HEX_MAX = 0xff
const CUBE_LEVELS = 5
/** Split coloured roles between normal and bright slots without discarding their hue family. */
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
 * Preserve hue distinctions for additions and warnings instead of reducing
 * every colour to a brightness-only grey. Exact threshold calibration remains
 * undocumented.
 */
const GREY_CHROMA = 30
/** Preserve a receding-to-bright grey hierarchy within four available slots; these are heuristic cutoffs, not contrast guarantees. */
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
  // `dumb` declares a terminal with no capabilities at all, so nothing below
  // can be trusted; NO_COLOR is not the only way to say "no styling here".
  if ((env.TERM ?? '') === 'dumb') return 'none'
  const colorterm = env.COLORTERM ?? ''
  if (colorterm === 'truecolor' || colorterm === '24bit') return 'truecolor'
  if ((env.TERM ?? '').includes('256color')) return '256'
  // Retain base-palette styling without advertising extended-colour support; this fallback is a policy, not a capability probe.
  return '16'
}

/** Parse a colour specification, or `undefined` when it is not one. */
function parseColour(spec: string | number): ParsedColour | undefined {
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

/** Approximate RGB for indexed terminals; uniform rounding does not guarantee the nearest non-linear xterm shade. */
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
 * Keep mixed hue families distinct from a dominant primary channel so warning
 * amber need not reduce to plain red on a 16-colour terminal.
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
 * A base-palette approximation for a triple.
 *
 * Preserve separate roles for receding greys and coloured additions or warnings
 * rather than reducing every role to black or white.
 */
function degradeTo16(rgb: Rgb): number {
  const max = Math.max(rgb.r, rgb.g, rgb.b)
  const min = Math.min(rgb.r, rgb.g, rgb.b)
  // A coarse channel average separates shade levels within the small palette; it is not perceptual luminance.
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

/** Ignore invalid colour forms so malformed input cannot become terminal parameters or interrupt text rendering. */
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
 * Approximation keeps hue families and receding greys recognizable on weaker
 * terminals; neither cube rounding nor base-palette heuristics guarantee the
 * nearest available shade.
 */
export function sgrPrefix(spec: string | number, mode: ColourMode): string {
  return colourSgr(spec, mode, 'fg')
}

/** The SGR prefix that starts a background colour, or empty when colour is off. */
export function sgrBackgroundPrefix(spec: string | number, mode: ColourMode): string {
  return colourSgr(spec, mode, 'bg')
}
