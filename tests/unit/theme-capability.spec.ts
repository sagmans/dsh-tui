import { describe, expect, it } from 'vitest'
import { detectColourMode, parseColour, sgrBackgroundPrefix, sgrPrefix } from '@/theme-capability.ts'

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

  it('treats a dumb terminal as no colour even without NO_COLOR', () => {
    expect(detectColourMode({ TERM: 'dumb' })).toBe('none')
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

describe('sgrBackgroundPrefix', () => {
  it('addresses the background layer on every budget', () => {
    expect(sgrBackgroundPrefix('#808080', 'truecolor')).toBe('\u001B[48;2;128;128;128m')
    expect(sgrBackgroundPrefix(8, '256')).toBe('\u001B[48;5;8m')
    expect(sgrBackgroundPrefix(8, '16')).toBe('\u001B[100m')
    expect(sgrBackgroundPrefix('#808080', 'none')).toBe('')
  })
})

describe('degrading a colour to 16 slots', () => {
  it('addresses a 256 index instead of emitting an invalid SGR code', () => {
    // Index 200 used to fall through to ansi16 and emit ESC[282m, which no
    // terminal understands.
    expect(sgrPrefix(200, 'truecolor')).toBe('\u001B[38;5;200m')
    expect(sgrPrefix(200, '256')).toBe('\u001B[38;5;200m')
    const code = Number(sgrPrefix(200, '16').slice(2, -1))
    expect(code).toBeGreaterThanOrEqual(30)
    expect(code).toBeLessThanOrEqual(97)
  })

  it('keeps a colour in its hue family instead of collapsing it to black', () => {
    // The muted addition green used to average under the threshold and become
    // slot 0 — black on a dark terminal.
    expect(sgrPrefix('#5faf5f', '16')).toBe('\u001B[32m')
    expect(sgrPrefix('#d75f5f', '16')).toBe('\u001B[91m')
  })

  it('keeps a receding grey apart from ordinary text', () => {
    expect(sgrPrefix('#8a8a8a', '16')).not.toBe(sgrPrefix('#d0d0d0', '16'))
  })
})
