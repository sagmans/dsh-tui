import { describe, expect, it } from 'vitest'
import { CLEAR_TITLE, TITLE_DIR_LIMIT, titleSequence, windowTitle } from '@/terminal/title.ts'

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
})

describe('windowTitle', () => {
  it('names the project and the state', () => {
    expect(windowTitle('/Users/dev/source/me/dsh-tui/main', 'working')).toBe(`${ESC}]0;dsh-tui · dsh-tui/main · working${BEL}`)
  })

  it('keeps a long path inside the tab', () => {
    const long = `/a/${'x'.repeat(80)}/end`
    const title = windowTitle(long, 'ready')
    expect(title.length).toBeLessThan(TITLE_DIR_LIMIT + 30)
    expect(title).toContain('…')
  })

  it('clears rather than guesses when asked to hand the title back', () => {
    expect(CLEAR_TITLE).toBe(`${ESC}]0;${BEL}`)
  })
})
