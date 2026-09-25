import { describe, expect, it } from 'vitest'
import { oneRow, sliceGraphemes, stripControlCharacters, tailGraphemes } from '@/text.ts'

const ESCAPE = '\u001b'
const CSI = '\u009b'

describe('oneRow', () => {
  it('keeps ordinary text and joins the rows a break separated', () => {
    expect(oneRow('plain é')).toBe('plain é')
    expect(oneRow('one\ntwo\r\nthree')).toBe('one two three')
  })

  it('joins the separators a terminal would treat as a new row', () => {
    expect(oneRow('a\u2028b\u2029c')).toBe('a b c')
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
    expect(stripControlCharacters('one\u061Ctwo\u200Ethree\u200Ffour\u2069five')).toBe('onetwothreefourfive')
  })

  it('keeps the zero-width marks a draft uses deliberately', () => {
    expect(stripControlCharacters('kept\u200Bzero\u200Dwidth')).toBe('kept\u200Bzero\u200Dwidth')
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
