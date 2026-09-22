import { describe, expect, it } from 'vitest'
import { displayText, oneRow, sliceGraphemes, stripControlCharacters, tailGraphemes } from '@/text.ts'

const ESCAPE = '\u001b'
const CSI = '\u009b'

describe('displayText', () => {
  it('leaves ordinary text and line feeds alone', () => {
    expect(displayText('plain \u00e9 \u4e2d\nsecond line')).toBe('plain \u00e9 \u4e2d\nsecond line')
  })

  it('renders the escape introducer as visible text', () => {
    expect(displayText(`${ESCAPE}[31mred`)).toBe('\\x1B[31mred')
  })

  it('renders a control sequence introduced by a C1 byte', () => {
    expect(displayText(`${CSI}2J`)).toBe('\\x9B2J')
  })

  it('escapes carriage return, bell, and delete, and lands a tab on its stop', () => {
    expect(displayText('a\rb\tc\u0007d\u007f')).toBe('a\\x0Db  c\\x07d\\x7F')
    expect(displayText('a\tb')).toBe(`a${' '.repeat(7)}b`)
    expect(displayText('\tb', { column: 4 })).toBe(`${' '.repeat(4)}b`)
  })

  it('keeps a tab when the text is meant to be stored or restored rather than drawn', () => {
    expect(displayText('a\tb', { tab: 'keep' })).toBe('a\tb')
  })

  it('escapes directional overrides that could reorder the frame', () => {
    expect(displayText('a\u202eb')).toBe('a\\u202Eb')
    expect(displayText('a\u2066b')).toBe('a\\u2066b')
  })

  it('replaces an unpaired surrogate', () => {
    expect(displayText('a\ud800b')).toBe('a\uFFFDb')
  })

  it('keeps emoji sequences intact, including the zero-width joiner', () => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'
    expect(displayText(family)).toBe(family)
  })

  it('keeps a full escape sequence inert for the terminal', () => {
    expect(displayText(`${ESCAPE}]0;pwned\u0007`)).toBe('\\x1B]0;pwned\\x07')
  })
})

describe('oneRow', () => {
  it('keeps ordinary text and joins the rows a break separated', () => {
    expect(oneRow('plain é')).toBe('plain é')
    expect(oneRow('one\ntwo\r\nthree')).toBe('one two three')
  })

  it('joins the separators a terminal would treat as a new row', () => {
    expect(oneRow('a b c')).toBe('a b c')
  })
})

describe('stripControlCharacters', () => {
  it('leaves the characters a draft legitimately needs', () => {
    expect(stripControlCharacters('plain \u00e9 \u4e2d\nsecond\tcolumn')).toBe('plain \u00e9 \u4e2d\nsecond\tcolumn')
  })

  it('removes the bytes that command a terminal from a restored draft', () => {
    expect(stripControlCharacters(`a${ESCAPE}]0;pwned\u0007b`)).toBe('a]0;pwnedb')
    expect(stripControlCharacters(`a${CSI}2Jb`)).toBe('a2Jb')
  })

  it('folds a CRLF draft into lines', () => {
    expect(stripControlCharacters('one\r\ntwo')).toBe('one\ntwo')
  })

  it('removes the bidi overrides nobody can see', () => {
    expect(stripControlCharacters('a\u202eb\u2066c')).toBe('abc')
  })
})

describe('sliceGraphemes', () => {
  it('keeps a joined emoji whole when the budget lands inside it', () => {
    const family = '👨‍👩‍👧'
    expect(sliceGraphemes(`a${family}b`, 2)).toBe(`a${family}`)
  })

  it('keeps a combining mark with the letter it modifies', () => {
    expect(sliceGraphemes('e\u0301x', 1)).toBe('e\u0301')
  })

  it('answers the whole text when the budget already covers it', () => {
    expect(sliceGraphemes('short', 10)).toBe('short')
    expect(sliceGraphemes('short', 0)).toBe('')
  })
})

describe('tailGraphemes', () => {
  it('keeps a joined emoji whole when the budget lands inside it', () => {
    const family = '👨‍👩‍👧'
    expect(tailGraphemes('a' + family + 'b', 2)).toBe(family + 'b')
  })

  it('keeps a combining mark with the letter it modifies', () => {
    expect(tailGraphemes('xe\u0301', 1)).toBe('e\u0301')
  })

  it('answers the whole text when the budget already covers it', () => {
    expect(tailGraphemes('short', 10)).toBe('short')
    expect(tailGraphemes('short', 0)).toBe('')
  })
})
