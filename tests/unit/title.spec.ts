import { describe, expect, it } from 'vitest'
import { CLEAR_TITLE, titleSequence, windowTitle } from '@/terminal/title.ts'

const BEL = '\u0007'
const ESC = '\u001b'

describe('titleSequence', () => {
  it('sets the window title', () => {
    expect(titleSequence('dsh-tui')).toBe(`${ESC}]0;dsh-tui${BEL}`)
  })

  it('strips anything that would end the sequence early', () => {
    const hostile = titleSequence(`a${BEL}${ESC}]0;pwned`)
    expect(hostile).toBe(`${ESC}]0;a]0;pwned${BEL}`)
    expect(hostile.indexOf(BEL)).toBe(hostile.length - 1)
  })

  it('strips the bidi overrides that would reorder the title', () => {
    // A title reaches the terminal's own escape sequence: an override that
    // survived would reorder the tab bar and the reader's scrollback, and it
    // draws nothing, so nothing about it can be seen or undone by hand.
    const hostile = 'a\u061Cb\u200Ec\u200Fd\u202Ae\u202Bf\u202Cg\u202Dh\u202Ei\u2066j\u2067k\u2068l\u2069m'
    expect(titleSequence(hostile)).toBe(`${ESC}]0;abcdefghijklm${BEL}`)
  })

  it('keeps the label on one row', () => {
    // The shared strip keeps the tab and line feed an editor lays text out
    // with, and drops the carriage return rather than turning it into a break;
    // a title has one row, so none of the three may survive.
    expect(titleSequence('a\tb\nc\rd')).toBe(`${ESC}]0;abcd${BEL}`)
  })
})

describe('windowTitle', () => {
  it('names the project and the state', () => {
    expect(windowTitle('/Users/dev/source/me/dsh-tui/main', 'working')).toBe(`${ESC}]0;dsh-tui · dsh-tui/main · working${BEL}`)
  })

  it('keeps a long path inside the tab', () => {
    const long = `/a/${'x'.repeat(80)}/end`
    // The cut keeps the deepest segment whole, so a tab bar still says which
    // checkout the session runs in after the path is shortened.
    expect(windowTitle(long, 'ready')).toBe(`${ESC}]0;dsh-tui · …${'x'.repeat(35)}/end · ready${BEL}`)
  })

  it('clears rather than guesses when asked to hand the title back', () => {
    expect(CLEAR_TITLE).toBe(`${ESC}]0;${BEL}`)
  })
})
