import { describe, expect, it } from 'vitest'
import { clipVisibleGraphemes, escapeTerminalText, renderTerminalText, TAB_STOP } from '@/terminal-text.ts'

const ESC = '\u001b'

/**
 * Every escape sequence in a string, so a test can prove the surface only ever
 * emits styling it opened itself: a run of text may carry SGR, never anything a
 * terminal would act on.
 */
function expectOnlySgr(text: string): void {
  const bare = text.replace(/\u001b\[[0-9;]*m/g, '')
  expect(bare.includes(ESC), `a non-SGR escape reached the screen: ${JSON.stringify(bare.slice(0, 80))}`).toBe(false)
}

describe('escapeTerminalText', () => {
  it('leaves printable text alone', () => {
    expect(escapeTerminalText('plain é 中\nsecond line')).toBe('plain é 中\nsecond line')
  })

  it('expands a tab to the next stop, seeded by the column it starts at', () => {
    expect(escapeTerminalText('a\tb')).toBe(`a${' '.repeat(TAB_STOP - 1)}b`)
    expect(escapeTerminalText('\tb')).toBe(`${' '.repeat(TAB_STOP)}b`)
    expect(escapeTerminalText('12345678\tb')).toBe(`12345678${' '.repeat(TAB_STOP)}b`)
    expect(escapeTerminalText('\tb', { column: 4 })).toBe(`${' '.repeat(4)}b`)
  })

  it('counts a wide grapheme as the cells it occupies, and restarts the stop each line', () => {
    expect(escapeTerminalText('中\tb')).toBe(`中${' '.repeat(TAB_STOP - 2)}b`)
    expect(escapeTerminalText('ab\n\tc')).toBe(`ab\n${' '.repeat(TAB_STOP)}c`)
  })

  it('keeps a tab when the caller stores or restores the text it came from', () => {
    expect(escapeTerminalText('a\tb', { tab: 'keep' })).toBe('a\tb')
  })

  it('spells every sequence and control character rather than acting on it', () => {
    expect(escapeTerminalText(`${ESC}[31mred`)).toBe('\\x1B[31mred')
    expect(escapeTerminalText('a\rb\u0007d\u007f')).toBe('a\\x0Db\\x07d\\x7F')
    expect(escapeTerminalText(`${ESC}]0;pwned\u0007`)).toBe('\\x1B]0;pwned\\x07')
    expect(escapeTerminalText('\u009b2J')).toBe('\\x9B2J')
    expect(escapeTerminalText('a\u202eb\u2066c')).toBe('a\\u202Eb\\u2066c')
    expect(escapeTerminalText('a\u2028b')).toBe('a\\u2028b')
    expect(escapeTerminalText(`${ESC}[31`)).toBe('\\x1B[31')
  })

  it('replaces an unpaired surrogate, which no font can draw', () => {
    expect(escapeTerminalText('a\ud800b')).toBe('a\uFFFDb')
  })
})

describe('renderTerminalText', () => {
  it('draws a tab on its stop and keeps line feeds', () => {
    expect(renderTerminalText('a\tb\nc', { color: '16' })).toBe(`a${' '.repeat(TAB_STOP - 1)}b\nc`)
  })

  it('draws a tool colour at the colour budget the session has', () => {
    expect(renderTerminalText(`${ESC}[31mred`, { color: '16' })).toBe(`${ESC}[31mred`)
    expect(renderTerminalText(`${ESC}[31mred`, { color: '256' })).toBe(`${ESC}[38;5;1mred`)
    expect(renderTerminalText(`${ESC}[91mred`, { color: '16' })).toBe(`${ESC}[91mred`)
    expect(renderTerminalText(`${ESC}[38;5;196mred`, { color: '16' })).toBe(`${ESC}[31mred`)
    expect(renderTerminalText(`${ESC}[38;2;1;2;3mx`, { color: 'truecolor' })).toBe(`${ESC}[38;2;1;2;3mx`)
    expect(renderTerminalText(`${ESC}[38;2;1;2;3mx`, { color: '256' })).toBe(`${ESC}[38;5;16mx`)
    expect(renderTerminalText(`${ESC}[44mbg`, { color: '16' })).toBe(`${ESC}[44mbg`)
  })

  it('emits no escape at all when the reader turned styling off', () => {
    const drawn = renderTerminalText(`${ESC}[1;31mred\u001b[0mplain\t<>`, { color: 'none' })
    expect(drawn).toBe(`redplain${' '.repeat(TAB_STOP)}<>`)
    expect(drawn.includes(ESC)).toBe(false)
  })

  it('carries the element\'s own colour as the ground a foreign reset returns to', () => {
    expect(renderTerminalText(`${ESC}[31mred${ESC}[0mplain`, { color: '16', base: `${ESC}[36m` }))
      .toBe(`${ESC}[31mred${ESC}[39m${ESC}[36mplain`)
    expect(renderTerminalText(`${ESC}[31mred${ESC}[0mplain`, { color: '16' }))
      .toBe(`${ESC}[31mred${ESC}[39mplain`)
  })

  it('turns attributes on and off without clearing what it did not set', () => {
    expect(renderTerminalText(`${ESC}[1mX${ESC}[22mY`, { color: '16' })).toBe(`${ESC}[1mX${ESC}[22mY`)
    expect(renderTerminalText(`${ESC}[1;4mX${ESC}[22mY`, { color: '16' })).toBe(`${ESC}[1m${ESC}[4mX${ESC}[22mY`)
    expect(renderTerminalText(`${ESC}[4mX${ESC}[24mY`, { color: '16' })).toBe(`${ESC}[4mX${ESC}[24mY`)
  })

  it('never emits a reset, so a tool cannot clear the colour it was drawn in', () => {
    for (const raw of [`${ESC}[31mred${ESC}[0mplain`, `${ESC}[1;38;5;196mX${ESC}[mY`]) {
      expect(renderTerminalText(raw, { color: 'truecolor', base: `${ESC}[36m` })).not.toContain(`${ESC}[0m`)
    }
  })

  it('consumes every sequence a terminal would act on instead of drawing it', () => {
    expect(renderTerminalText('a\u001b[2Jb', { color: '16' })).toBe('ab')
    expect(renderTerminalText('a\u001b[?25lb', { color: '16' })).toBe('ab')
    expect(renderTerminalText('a\u001b[2K\u001b[1Ab', { color: '16' })).toBe('ab')
    expect(renderTerminalText(`a${ESC}]0;title\u0007b`, { color: '16' })).toBe('ab')
    expect(renderTerminalText(`a${ESC}]52;c;cGF5bG9hZA==\u0007b`, { color: '16' })).toBe('ab')
    expect(renderTerminalText(`a${ESC}]8;;https://x\u0007link${ESC}]8;;\u0007b`, { color: '16' })).toBe('alinkb')
    expect(renderTerminalText(`a${ESC}Pq${ESC}\\b`, { color: '16' })).toBe('ab')
    expect(renderTerminalText(`a${ESC}]0;unterminated`, { color: '16' })).toBe('a')
    expect(renderTerminalText(`a${ESC}[38:5:196mx`, { color: '16' })).toBe('ax')
    expect(renderTerminalText(`a${ESC}cb`, { color: '16' })).toBe('ab')
  })

  it('spells a control character it does not recognise rather than swallowing it', () => {
    expect(renderTerminalText('a\u0007b', { color: '16' })).toBe('a\\x07b')
    expect(renderTerminalText('a\u009bb', { color: '16' })).toBe('a\\x9Bb')
    expect(renderTerminalText('a\u202eb', { color: '16' })).toBe('a\\u202Eb')
    expect(renderTerminalText('a\ud800b', { color: '16' })).toBe('a\uFFFDb')
  })

  it('collapses a carriage return to the state the line settles on', () => {
    expect(renderTerminalText('abc\rXY', { color: '16' })).toBe('XYc')
    expect(renderTerminalText('10%\r20%\r100%', { color: '16' })).toBe('100%')
    expect(renderTerminalText('abc\r', { color: '16' })).toBe('abc')
    // The column a fragment starts at is a left margin: a carriage return in tool
    // output must repaint the fragment, never the indentation that holds it.
    expect(renderTerminalText('abcd\rXY', { color: '16', column: 4 })).toBe('XYcd')
    expect(renderTerminalText('one\r\ntwo', { color: '16' })).toBe('one\ntwo')
    expect(renderTerminalText('abc\bX', { color: '16' })).toBe('abX')
  })

  it('keeps the styling of what survives a repaint of the line', () => {
    expect(renderTerminalText(`${ESC}[31m10%${ESC}[0m\r${ESC}[32m100%${ESC}[0m`, { color: '16' }))
      .toBe(`${ESC}[32m100%`)
  })

  it('carries an open style across a line feed', () => {
    expect(renderTerminalText(`a${ESC}[31m\nb`, { color: '16' })).toBe(`a\n${ESC}[31mb`)
  })

  it('only ever emits styling of its own', () => {
    const hostile = [
      `${ESC}[31mred${ESC}[0m`,
      `${ESC}[2J${ESC}[?25l${ESC}]52;c;cGF5bG9hZA==\u0007`,
      `${ESC}[38;5;196mX${ESC}[48;2;0;0;0mY${ESC}[mZ`,
      `${ESC}[1;2;3;4;7;9mattrs${ESC}[21;23;24;27;29moff`,
      `${ESC}]0;${'a'.repeat(5000)}\u0007`,
      `${ESC}[${'1;'.repeat(5000)}31mbad`,
    ]
    for (const raw of hostile) expectOnlySgr(renderTerminalText(raw, { color: 'truecolor', base: `${ESC}[36m` }))
  })
})

describe('clipVisibleGraphemes', () => {
  it('counts what the reader sees, not the sequences around it', () => {
    expect(clipVisibleGraphemes('abcdef', 3)).toBe('ab…')
    expect(clipVisibleGraphemes(`${ESC}[31mabcdef`, 3)).toBe(`${ESC}[31mab…`)
    expect(clipVisibleGraphemes(`${ESC}[31mab`, 9)).toBe(`${ESC}[31mab`)
  })

  it('keeps a whole sequence rather than cutting through it', () => {
    const long = `a${ESC}]0;${'t'.repeat(40)}\u0007b`
    expect(clipVisibleGraphemes(long, 3)).toBe(long)
    expect(clipVisibleGraphemes(`ab${ESC}[31mcdef`, 4)).toBe(`ab${ESC}[31mc…`)
    expect(clipVisibleGraphemes('a👨‍👩bc', 3)).toBe('a👨‍👩…')
  })
})
