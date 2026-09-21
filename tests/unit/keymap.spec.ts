import { getKeybindings, type KeyId } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { defaultKeymap, resolveKeymap } from '@/input/actions.ts'
import {
  ChordReader,
  DEFAULT_PREFIX_KEYS,
  DEFAULT_PREFIX_KEY,
  DEFAULT_PREFIX_WINDOW_S,
  chordBindings,
  chordKeysLine,
  installKeybindings,
  promptKeys,
  surfaceKeysLine,
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

function reader(prefixes: readonly KeyId[] = DEFAULT_PREFIX_KEYS, windowMs = DEFAULT_PREFIX_WINDOW_S * 1000, map = defaultKeymap()): { chord: ChordReader; clock: FakeClock } {
  const clock = fakeClock()
  return {
    chord: new ChordReader(() => prefixes, () => chordBindings(map), () => windowMs, () => {
      expired += 1
    }, clock),
    clock,
  }
}

describe('the key tables', () => {
  it('names every key the surface answers, for help and for the refusal message', () => {
    const line = surfaceKeysLine(defaultKeymap())
    expect(line).toContain('ctrl+o tool detail')
    expect(line).toContain('ctrl+r search prompt history')
    expect(line.split(' · ')).toHaveLength(7)
  })

  it('reads the keys the reader wrote wherever help is asked for', () => {
    const line = surfaceKeysLine(resolveKeymap({ 'surface.effort': 'ctrl+e' }))
    expect(line).toContain('ctrl+e reasoning effort')
    expect(line).not.toContain('ctrl+t')
  })

  it('asks for the stash, the model picker, the plan, and the copy through the command line submissions', () => {
    const bindings = chordBindings(defaultKeymap())
    // The chord has its own kind because it parks the editor's own draft, which
    // a submitted command cannot: the line it was typed on is gone by then.
    expect(bindings.find(entry => entry.key === 's')?.submission).toEqual({ kind: 'stash-draft' })
    expect(bindings.find(entry => entry.key === 'l')?.submission).toEqual({ kind: 'stash-list' })
    expect(bindings.find(entry => entry.key === 'm')?.submission).toEqual({ kind: 'model', argument: '' })
    expect(bindings.find(entry => entry.key === 'p')?.submission).toEqual({ kind: 'plan' })
    expect(bindings.find(entry => entry.key === 'y')?.submission).toEqual({ kind: 'copy' })
    expect(chordKeysLine(defaultKeymap())).toBe('ctrl+x then m model · p plan mode · y copy · s stash the draft · l stashed drafts')
  })

  it('reads a chord the reader moved, and a prefix they changed', () => {
    const map = resolveKeymap({ 'chord.prefix': 'alt+z', 'chord.model': 'n' })
    expect(chordKeysLine(map)).toBe('alt+z then n model · p plan mode · y copy · s stash the draft · l stashed drafts')
    expect(chordBindings(map).find(entry => entry.label === 'model')?.key).toBe('n')
  })
})

describe('installKeybindings', () => {
  it('installs the send chords over the Enter the library ships', () => {
    installKeybindings(defaultKeymap())
    const keys = getKeybindings()
    expect(keys.matches('\u001b[13;5u', 'tui.input.submit')).toBe(true)
    expect(keys.matches('\u001b[13;3u', 'tui.input.submit')).toBe(true)
    expect(keys.matches('\u0013', 'tui.input.submit')).toBe(true)
    expect(keys.matches('\r', 'tui.input.submit')).toBe(false)
  })

  it('installs a send key the reader chose in place of the shipped ones', () => {
    installKeybindings(resolveKeymap({ 'prompt.submit': 'ctrl+g' }))
    const keys = getKeybindings()
    expect(keys.matches('\u0007', 'tui.input.submit')).toBe(true)
    expect(keys.matches('\u0013', 'tui.input.submit')).toBe(false)
  })

  it('installs a library action the reader bound', () => {
    installKeybindings(resolveKeymap({ 'tui.editor.yank': 'ctrl+g', 'tui.editor.historyPrevious': 'alt+p' }))
    const keys = getKeybindings()
    expect(keys.matches('\u0007', 'tui.editor.yank')).toBe(true)
    expect(keys.matches('\u001bp', 'tui.editor.historyPrevious')).toBe(true)
  })

  it('leaves a library action the reader did not write on the library own keys', () => {
    installKeybindings(resolveKeymap({ 'tui.editor.yank': 'ctrl+g' }))
    expect(getKeybindings().matches('\u001b[1;3D', 'tui.editor.cursorWordLeft')).toBe(true)
  })

  it('unbinds the library newline keys when the reader leaves the line to Enter alone', () => {
    installKeybindings(resolveKeymap({ 'prompt.newLine': ['enter'], 'prompt.submit': 'ctrl+g' }))
    const keys = getKeybindings()
    expect(keys.matches('\u001b[13;2u', 'tui.input.newLine')).toBe(false)
    expect(keys.matches('\n', 'tui.input.newLine')).toBe(false)
  })

  it('installs a reloaded map where the library is what answers a press', () => {
    // A settings edit re-installs the tables, and the library is what the editor
    // asks: the key the reader moved to has to land there and the shipped one
    // has to stop answering.
    installKeybindings(resolveKeymap({}))
    expect(getKeybindings().matches('\u0007', 'tui.input.submit')).toBe(false)
    installKeybindings(resolveKeymap({ 'prompt.submit': 'ctrl+g' }))
    expect(getKeybindings().matches('\u0007', 'tui.input.submit')).toBe(true)
    expect(getKeybindings().matches('\u0013', 'tui.input.submit')).toBe(false)
  })

  it('keeps Enter out of the library newline binding, which the bar answers itself', () => {
    installKeybindings(defaultKeymap())
    const keys = getKeybindings()
    expect(keys.matches('\u001b[13;2u', 'tui.input.newLine')).toBe(true)
    expect(keys.matches('\n', 'tui.input.newLine')).toBe(true)
    expect(keys.matches('\r', 'tui.input.newLine')).toBe(false)
  })
})

describe('promptKeys', () => {
  it('keeps Enter for the line and reads the shipped send chords', () => {
    const keys = promptKeys(defaultKeymap())
    expect(keys.submit).toEqual(['ctrl+enter', 'alt+enter', 'ctrl+s'])
    expect(keys.newLine).toEqual(['enter', 'shift+enter', 'ctrl+j'])
    expect(keys.enterBreaksLine).toBe(true)
  })

  it('lets Enter send once the reader moves the line break off it', () => {
    const keys = promptKeys(resolveKeymap({ 'prompt.submit': ['enter'], 'prompt.newLine': ['shift+enter'] }))
    expect(keys.enterBreaksLine).toBe(false)
  })

  it('reads whatever the reader sends with, including one chord alone', () => {
    expect(promptKeys(resolveKeymap({ 'prompt.submit': 'ctrl+g' })).submit).toEqual(['ctrl+g'])
    expect(promptKeys(resolveKeymap({ 'prompt.submit': ['alt+enter'] })).submit).toEqual(['alt+enter'])
    expect(promptKeys(resolveKeymap({ 'prompt.submit': ['ctrl+j'], 'prompt.newLine': ['enter', 'shift+enter'] })).submit).toEqual(['ctrl+j'])
  })
})

describe('ChordReader', () => {
  it('arms on the prefix, says so, and dispatches the bound key', () => {
    const { chord } = reader()
    expect(chord.pending).toBe(false)
    expect(chord.handle('\u0018')).toEqual({ kind: 'armed' })
    expect(chord.pending).toBe(true)
    expect(chord.hint()).toBe('ctrl+x')
    expect(chord.handle('m')).toEqual({ kind: 'action', binding: chordBindings(defaultKeymap())[0] })
    expect(chord.pending).toBe(false)
    expect(chord.hint()).toBeUndefined()
  })

  it('dispatches the copy chord', () => {
    const { chord } = reader()
    chord.handle('\u0018')
    expect(chord.handle('y')).toEqual({ kind: 'action', binding: chordBindings(defaultKeymap()).find(entry => entry.label === 'copy') })
  })

  it('dispatches the plan chord', () => {
    const { chord } = reader()
    chord.handle('\u0018')
    expect(chord.handle('p')).toEqual({ kind: 'action', binding: chordBindings(defaultKeymap()).find(entry => entry.label === 'plan mode') })
    expect(chord.handle('p')).toBeUndefined()
  })

  it('takes a second key the reader moved, and no longer the shipped one', () => {
    const map = resolveKeymap({ 'chord.model': 'n' })
    const { chord } = reader([DEFAULT_PREFIX_KEY], DEFAULT_PREFIX_WINDOW_S * 1000, map)
    chord.handle('\u0018')
    expect(chord.handle('m')).toBeUndefined()
    chord.handle('\u0018')
    expect(chord.handle('n')).toEqual({ kind: 'action', binding: chordBindings(map)[0] })
  })

  it('takes a second key that is itself a chord', () => {
    const map = resolveKeymap({ 'chord.copy': 'ctrl+y' })
    const { chord } = reader([DEFAULT_PREFIX_KEY], DEFAULT_PREFIX_WINDOW_S * 1000, map)
    chord.handle('\u0018')
    expect(chord.handle('\u0019')).toEqual({ kind: 'action', binding: chordBindings(map).find(entry => entry.label === 'copy') })
  })

  it('dispatches the stash chords', () => {
    const bindings = chordBindings(defaultKeymap())
    const { chord } = reader()
    chord.handle('\u0018')
    expect(chord.handle('s')).toEqual({ kind: 'action', binding: bindings.find(entry => entry.key === 's') })
    chord.handle('\u0018')
    expect(chord.handle('l')).toEqual({ kind: 'action', binding: bindings.find(entry => entry.key === 'l') })
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
    const { chord, clock } = reader([DEFAULT_PREFIX_KEY], 0)
    chord.handle('\u0018')
    expect(clock.scheduled()).toBeUndefined()
    expect(chord.pending).toBe(true)
  })

  it('passes an ordinary key through while unarmed', () => {
    const { chord } = reader()
    expect(chord.handle('m')).toBeUndefined()
    expect(chord.pending).toBe(false)
  })

  it('arms on any prefix the reader listed, and names the one that was pressed', () => {
    const { chord } = reader(['ctrl+x', 'ctrl+g'])
    expect(chord.handle('\u0007')).toEqual({ kind: 'armed' })
    expect(chord.hint()).toBe('ctrl+g')
    chord.disarm()
    expect(chord.handle('\u0018')).toEqual({ kind: 'armed' })
    expect(chord.hint()).toBe('ctrl+x')
  })

  it('hands the next key back when a settings edit lands mid-chord', () => {
    // The surface disarms on a reload: the second key of a chord armed under the
    // old map is not a key the reader chose in the new one.
    let prefixes: readonly KeyId[] = ['ctrl+x']
    let bindings = chordBindings(defaultKeymap())
    const chord = new ChordReader(() => prefixes, () => bindings, () => 0, () => {})
    expect(chord.handle('\u0018')).toEqual({ kind: 'armed' })
    prefixes = ['alt+x']
    bindings = chordBindings(resolveKeymap({ 'chord.model': 'n' }))
    chord.disarm()
    expect(chord.pending).toBe(false)
    expect(chord.hint()).toBeUndefined()
    expect(chord.handle('m')).toBeUndefined()
    expect(chord.handle('\u001bx')).toEqual({ kind: 'armed' })
    expect(chord.handle('n')).toEqual({ kind: 'action', binding: bindings[0] })
  })

  it('follows a prefix the reader changed without being rebuilt', () => {
    let prefixes: readonly KeyId[] = ['ctrl+x']
    let bindings = chordBindings(defaultKeymap())
    const chord = new ChordReader(() => prefixes, () => bindings, () => 0, () => {})
    expect(chord.handle('\u0018')).toEqual({ kind: 'armed' })
    chord.disarm()
    prefixes = ['alt+x']
    bindings = chordBindings(resolveKeymap({ 'chord.model': 'n' }))
    expect(chord.handle('\u0018')).toBeUndefined()
    expect(chord.handle('\u001bx')).toEqual({ kind: 'armed' })
    expect(chord.handle('n')).toEqual({ kind: 'action', binding: bindings[0] })
  })
})
