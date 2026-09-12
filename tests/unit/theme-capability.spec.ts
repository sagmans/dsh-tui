import { describe, expect, it } from 'vitest'
import { detectColourMode, parseColour, sgrPrefix } from '@/theme-capability.ts'

describe('detectColourMode', () => {
  it('prefers truecolor when COLORTERM says so', () => {
    expect(detectColourMode({ COLORTERM: 'truecolor', TERM: 'xterm-256color' })).toBe('truecolor')
    expect(detectColourMode({ COLORTERM: '24bit', TERM: 'xterm-256color' })).toBe('truecolor')
  })

  it('falls back to 256 then 16', () => {
    expect(detectColourMode({ TERM: 'xterm-256color' })).toBe('256')
    expect(detectColourMode({ TERM: 'xterm' })).toBe('16')
    expect(detectColourMode({})).toBe('16')
  })

  it('honours NO_COLOR over every capability', () => {
    expect(detectColourMode({ NO_COLOR: '1', COLORTERM: 'truecolor' })).toBe('none')
    expect(detectColourMode({ NO_COLOR: ' ' })).toBe('none')
  })

  it('treats an empty NO_COLOR as unset, as the convention says', () => {
    expect(detectColourMode({ NO_COLOR: '', TERM: 'xterm-256color' })).toBe('256')
  })
})

describe('parseColour', () => {
  it('reads hex', () => {
    expect(parseColour('#808080')).toEqual({ r: 128, g: 128, b: 128 })
  })

  it('reads an ansi index', () => {
    expect(parseColour(8)).toBe(8)
  })

  it('rejects nonsense', () => {
    expect(parseColour('#gggggg')).toBeUndefined()
    expect(parseColour('nope')).toBeUndefined()
    expect(parseColour(-1)).toBeUndefined()
    expect(parseColour(999)).toBeUndefined()
  })
})

describe('sgrPrefix', () => {
  it('emits 24-bit colour as truecolor', () => {
    expect(sgrPrefix('#808080', 'truecolor')).toBe('\u001B[38;2;128;128;128m')
  })

  it('emits ansi indices on 16-colour terminals', () => {
    expect(sgrPrefix(8, '16')).toBe('\u001B[90m')
    expect(sgrPrefix(1, '16')).toBe('\u001B[31m')
  })

  it('emits nothing when colour is off', () => {
    expect(sgrPrefix('#808080', 'none')).toBe('')
    expect(sgrPrefix(8, 'none')).toBe('')
  })
})
