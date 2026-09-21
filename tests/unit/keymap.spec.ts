import { getKeybindings } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import {
  CHORD_BINDINGS,
  ChordReader,
  DEFAULT_PREFIX_KEY,
  DEFAULT_PREFIX_WINDOW_S,
  EDITOR_SUBMIT_KEYS,
  SURFACE_KEYS,
  installEditorKeybindings,
  chordKeysLine,
  surfaceKeysLine,
  validatePrefix,
  type ChordTimers,
} from '@/input/keymap.ts'

/** A clock the test owns, so a window is proven without waiting for one. */
interface FakeClock extends ChordTimers {
  fire(): void
  scheduled(): number | undefined
  readonly cancelled: number
}

function fakeClock(): FakeClock {
  let pending: (() => void) | undefined
  let delay: number | undefined
  let cancelled = 0
  return {
    schedule: (run, delayMs) => {
      pending = run
      delay = delayMs
      return 1
    },
    cancel: () => {
      cancelled += 1
      pending = undefined
      delay = undefined
    },
    fire: () => {
      pending?.()
    },
    scheduled: () => delay,
    get cancelled() {
      return cancelled
    },
  }
}

let expired = 0

function reader(prefix: string = DEFAULT_PREFIX_KEY, windowMs = DEFAULT_PREFIX_WINDOW_S * 1000): { chord: ChordReader; clock: FakeClock } {
  const clock = fakeClock()
  return {
    chord: new ChordReader(() => prefix as never, () => windowMs, () => {
      expired += 1
    }, clock),
    clock,
  }
}

describe('validatePrefix', () => {
  it('takes a modifier chord', () => {
    expect(validatePrefix('ctrl+x')).toBe('ctrl+x')
    expect(validatePrefix('alt+x')).toBe('alt+x')
    expect(validatePrefix('ctrl+shift+m')).toBe('ctrl+shift+m')
  })

  it('refuses a bare key, which would eat the reader typing it', () => {
    expect(() => validatePrefix('x')).toThrow(/modifier chord/)
    expect(() => validatePrefix('enter')).toThrow(/modifier chord/)
    expect(() => validatePrefix('ctrl+')).toThrow(/modifier chord/)
    expect(() => validatePrefix('CTRL+X')).toThrow(/modifier chord/)
  })

  it('refuses a key the surface answers itself', () => {
    for (const entry of SURFACE_KEYS) expect(() => validatePrefix(entry.key)).toThrow(/surface/)
    expect(() => validatePrefix('ctrl+c')).toThrow(/interrupt or exit/)
  })

  it('refuses a key the surface sends with, which a prefix would swallow', () => {
    expect(() => validatePrefix('ctrl+s')).toThrow(/submit/)
  })

  it('refuses a key the terminal owns, which would never arrive', () => {
    expect(() => validatePrefix('ctrl+q')).toThrow(/terminal/)
  })
})

describe('the key tables', () => {
  it('names every key the surface answers, for help and for the refusal message', () => {
    expect(surfaceKeysLine()).toContain('ctrl+o tool detail')
    expect(surfaceKeysLine().split(' · ')).toHaveLength(SURFACE_KEYS.length)
  })

  it('installs the send chords over the Enter the library ships', () => {
    installEditorKeybindings()
    const keys = getKeybindings()
    for (const chord of EDITOR_SUBMIT_KEYS) {
      const data = chord === 'ctrl+enter' ? '\u001b[13;5u' : chord === 'alt+enter' ? '\u001b[13;3u' : '\u0013'
      expect(keys.matches(data, 'tui.input.submit'), chord).toBe(true)
    }
    expect(keys.matches('\r', 'tui.input.submit')).toBe(false)
  })

  it('asks for the model picker and the copy through the command line submissions', () => {
    expect(CHORD_BINDINGS.find(entry => entry.key === 'm')?.submission).toEqual({ kind: 'model', argument: '' })
    expect(CHORD_BINDINGS.find(entry => entry.key === 'y')?.submission).toEqual({ kind: 'copy' })
    expect(chordKeysLine('ctrl+x')).toBe('ctrl+x then m model · y copy')
  })
})

describe('ChordReader', () => {
  it('arms on the prefix, says so, and dispatches the bound key', () => {
    const { chord } = reader()
    expect(chord.pending).toBe(false)
    expect(chord.handle('\u0018')).toEqual({ kind: 'armed' })
    expect(chord.pending).toBe(true)
    expect(chord.hint()).toBe('ctrl+x')
    expect(chord.handle('m')).toEqual({ kind: 'action', binding: CHORD_BINDINGS[0] })
    expect(chord.pending).toBe(false)
    expect(chord.hint()).toBeUndefined()
  })

  it('dispatches the copy chord', () => {
    const { chord } = reader()
    chord.handle('\u0018')
    expect(chord.handle('y')).toEqual({ kind: 'action', binding: CHORD_BINDINGS[1] })
  })

  it('hands an unbound second key back rather than swallowing it', () => {
    const { chord } = reader()
    chord.handle('\u0018')
    expect(chord.handle('h')).toBeUndefined()
    expect(chord.pending).toBe(false)
  })

  it('never treats a paste as the second key', () => {
    const { chord } = reader()
    chord.handle('\u0018')
    expect(chord.handle('\u001b[200~m\u001b[201~')).toBeUndefined()
    expect(chord.pending).toBe(false)
  })

  it('lets the chord lapse when the window passes', () => {
    expired = 0
    const { chord, clock } = reader()
    chord.handle('\u0018')
    expect(clock.scheduled()).toBe(2000)
    clock.fire()
    expect(chord.pending).toBe(false)
    expect(expired).toBe(1)
    // The key after a lapsed chord is an ordinary key again.
    expect(chord.handle('m')).toBeUndefined()
  })

  it('cancels the window when the chord finishes first, and on disarm', () => {
    const { chord, clock } = reader()
    chord.handle('\u0018')
    chord.handle('m')
    expect(clock.cancelled).toBe(1)
    chord.handle('\u0018')
    chord.disarm()
    expect(clock.cancelled).toBe(2)
    expect(chord.pending).toBe(false)
  })

  it('schedules nothing when the reader asks for a sticky chord', () => {
    const { chord, clock } = reader(DEFAULT_PREFIX_KEY, 0)
    chord.handle('\u0018')
    expect(clock.scheduled()).toBeUndefined()
    expect(chord.pending).toBe(true)
  })

  it('passes an ordinary key through while unarmed', () => {
    const { chord } = reader()
    expect(chord.handle('m')).toBeUndefined()
    expect(chord.pending).toBe(false)
  })

  it('follows a prefix the reader changed without being rebuilt', () => {
    let prefix = 'ctrl+x'
    const chord = new ChordReader(() => prefix as never, () => 0, () => {})
    expect(chord.handle('\u0018')).toEqual({ kind: 'armed' })
    chord.disarm()
    prefix = 'alt+x'
    expect(chord.handle('\u0018')).toBeUndefined()
    expect(chord.handle('\u001bx')).toEqual({ kind: 'armed' })
  })
})
