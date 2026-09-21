import { describe, expect, it } from 'vitest'
import { ghostDisplayLine, ghostGraphemes, ghostSuffix, isCursorAtTextEnd, nextGhostWord } from '@/input/ghost.ts'

const atEnd = (text: string) => {
  const lines = text.split('\n')
  const line = lines.length - 1
  return { lines, cursor: { line, col: (lines[line] ?? '').length } }
}

describe('isCursorAtTextEnd', () => {
  it('is true only on the last line, past its last character', () => {
    expect(isCursorAtTextEnd({ lines: ['one'], cursor: { line: 0, col: 3 } })).toBe(true)
    expect(isCursorAtTextEnd({ lines: ['one'], cursor: { line: 0, col: 1 } })).toBe(false)
    expect(isCursorAtTextEnd({ lines: ['one', 'two'], cursor: { line: 0, col: 3 } })).toBe(false)
  })
})

describe('ghostSuffix', () => {
  it('offers the rest of the newest entry the typed text starts', () => {
    const input = { entries: [{ text: 'fix the parser' }, { text: 'fix the tests' }], text: 'fix ', ...atEnd('fix ') }
    expect(ghostSuffix(input)).toBe('the parser')
  })

  it('skips an entry identical to what is typed so no empty ghost is drawn', () => {
    const input = { entries: [{ text: 'fix it' }, { text: 'fix it now' }], text: 'fix it', ...atEnd('fix it') }
    expect(ghostSuffix(input)).toBe(' now')
  })

  it('offers nothing for an empty prompt', () => {
    const input = { entries: [{ text: 'anything' }], text: '', ...atEnd('') }
    expect(ghostSuffix(input)).toBeUndefined()
  })

  it('offers nothing when no entry starts with the typed text', () => {
    const input = { entries: [{ text: 'unrelated' }], text: 'fix', ...atEnd('fix') }
    expect(ghostSuffix(input)).toBeUndefined()
  })

  it('offers nothing when the cursor is not at the end of the text', () => {
    const input = { entries: [{ text: 'fix the parser' }], text: 'fix', lines: ['fix'], cursor: { line: 0, col: 0 } }
    expect(ghostSuffix(input)).toBeUndefined()
  })

  it('matches a multiline prompt by its whole text', () => {
    const typed = 'first\nsecond'
    const input = { entries: [{ text: 'first\nsecond\nthird' }], text: typed, ...atEnd(typed) }
    expect(ghostSuffix(input)).toBe('\nthird')
  })
})

describe('nextGhostWord', () => {
  it('keeps leading whitespace with the first word', () => {
    expect(nextGhostWord('  the parser')).toBe('  the')
  })

  it('returns the first word when it starts the suffix', () => {
    expect(nextGhostWord('the parser')).toBe('the')
  })

  it('returns undefined for an empty suffix', () => {
    expect(nextGhostWord('')).toBeUndefined()
  })
})

describe('ghostDisplayLine', () => {
  it('draws a single-line suffix as it reads', () => {
    expect(ghostDisplayLine('the parser')).toBe('the parser')
  })

  it('marks a folded suffix so the reader knows it continues', () => {
    expect(ghostDisplayLine('the parser\nand more')).toBe('the parser\u21b5')
    expect(ghostDisplayLine('\nand more')).toBe('\u21b5')
  })
})

describe('ghostGraphemes', () => {
  it('keeps a multi-codepoint cluster intact', () => {
    expect(ghostGraphemes('a\u{1F468}\u200D\u{1F469}\u200D\u{1F467}b')).toEqual(['a', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}', 'b'])
  })
})
