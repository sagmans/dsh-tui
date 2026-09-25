/**
 * The style state a renderer models: which attributes are on, which colour each
 * names, and the sequences that move one state to the next.
 *
 * Apart from the grammar that reads those sequences and the renderer that emits
 * rows, because which attributes and colours a terminal may set is a policy
 * this surface owns, not a property of either.
 */

import { sgrBackgroundPrefix, sgrPrefix, type ColourMode } from '../theme-capability.ts'
import { ESC, RESET, parseSgrParams, type Token } from './scan.ts'

export const CSI = `${ESC}[`

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

const GROUND_FG = `${CSI}${FG_DEFAULT}m`

const GROUND_BG = `${CSI}${BG_DEFAULT}m`

export interface TextStyle {
  readonly fg?: string | undefined
  readonly bg?: string | undefined
  /** Attribute bits, so two styles compare by value without walking a set. */
  readonly attributes: number
}

export const GROUND: TextStyle = { attributes: 0 }

function withAttributes(style: TextStyle, on: Attribute | undefined, off: readonly Attribute[] | undefined): TextStyle {
  let attributes = style.attributes
  if (off !== undefined) for (const attribute of off) attributes &= ~(1 << ATTRIBUTES.indexOf(attribute))
  if (on !== undefined) attributes |= 1 << ATTRIBUTES.indexOf(on)
  return attributes === style.attributes ? style : { ...style, attributes }
}

function hasAttribute(style: TextStyle, attribute: Attribute): boolean {
  return (style.attributes & (1 << ATTRIBUTES.indexOf(attribute))) !== 0
}

export interface Encoder {
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
export function encoder(color: ColourMode, base: string): Encoder {
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
export function applySgr(style: TextStyle, params: readonly number[], color: ColourMode): TextStyle {
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
