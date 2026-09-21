import { describe, expect, it } from 'vitest'
import { fuzzyScore } from '@/input/fuzzy.ts'

/**
 * Every ordering asserted here is the order the fzf binary prints for the same
 * fragment and candidates, so this spec pins parity with the finder readers
 * already trust instead of restating the implementation's arithmetic.
 */
describe('fuzzyScore', () => {
  it('takes an empty filter as no narrowing at all', () => {
    expect(fuzzyScore('', 'anything')).toBeDefined()
    expect(fuzzyScore('   ', 'anything')).toBeDefined()
  })

  it('refuses a fragment whose characters are not all there in order', () => {
    expect(fuzzyScore('edtr', 'editor.ts')).toBeDefined()
    expect(fuzzyScore('rtde', 'editor.ts')).toBeUndefined()
    expect(fuzzyScore('tsx', 'editor.ts')).toBeUndefined()
  })

  it('ignores case', () => {
    expect(fuzzyScore('EDTR', 'src/ui/editor.ts')).toBeDefined()
  })

  it('prefers a run over a gap that splits it', () => {
    const run = fuzzyScore('foob', 'foobar')
    const split = fuzzyScore('foob', 'foo-bar')
    expect(run).toBeGreaterThan(split ?? 0)
  })

  it('prefers two word starts over one long run', () => {
    const words = fuzzyScore('ff', 'fuzzy-finder')
    const run = fuzzyScore('ff', 'fuzzyfinder')
    expect(words).toBeGreaterThan(run ?? 0)
  })

  it('gives a chunk the bonus of the character that started it', () => {
    const boundary = fuzzyScore('oob', 'out-of-bound')
    const inline = fuzzyScore('oob', 'foobar')
    expect(boundary).toBeGreaterThan(inline ?? 0)
  })

  it('gives a camelCase hump the credit a separator gets', () => {
    const camel = fuzzyScore('gc', 'getConfig')
    const plain = fuzzyScore('gc', 'gabcdc')
    expect(camel).toBeGreaterThan(plain ?? 0)
  })

  it('keeps a spread-out match below a tight one', () => {
    const tight = fuzzyScore('abc', 'a-b-c')
    const wide = fuzzyScore('abc', 'a--b--c')
    expect(tight).toBeGreaterThan(wide ?? 0)
  })

  it('finds the tightest reading, not the first character the row happens to show', () => {
    const tight = fuzzyScore('glm53', 'zai-coding-cn glm-5.3')
    const spread = fuzzyScore('glm53', 'kimi-coding g-l-m-5-3')
    expect(tight).toBeGreaterThan(spread ?? 0)
  })

  it('prefers a match that starts on a word boundary', () => {
    const boundary = fuzzyScore('ui', 'src/ui/editor.ts')
    const inside = fuzzyScore('ui', 'build/guile.ts')
    expect(boundary).toBeGreaterThan(inside ?? 0)
  })
})

/**
 * fzf folds each rune on its own. JavaScript's whole-string lowercase can
 * expand one character into two or change a letter into a form that depends on
 * its neighbours, and either one slides every later index out of alignment.
 */
describe('fuzzyScore outside ASCII', () => {
  it('matches a letter whose lowercase depends on where it sits', () => {
    expect(fuzzyScore('Σ', 'ΟΣ')).toBeDefined()
    expect(fuzzyScore('σ', 'ΟΣ')).toBeDefined()
  })

  it('keeps its place when a lowercase would expand to two code points', () => {
    expect(fuzzyScore('a', 'İa')).toBeGreaterThan(0)
  })

  it('folds a dotted capital into the letter a reader would type', () => {
    expect(fuzzyScore('i', 'İ')).toBeGreaterThan(0)
  })

  it('reads a space outside ASCII as a space rather than a word break', () => {
    // fzf scores ab the same after an em space as at the start of a text, and
    // leaves a zero-width space a word break; both are pinned apart.
    expect(fuzzyScore('ab', '\u2003ab')).toBe(62)
    expect(fuzzyScore('ab', '\u200bab')).toBe(56)
    expect(fuzzyScore('ab', 'x/ab')).toBe(59)
  })

  it('reads a letter outside ASCII as a letter rather than a word break', () => {
    // fzf scores ab in éab as a plain run and ab in zAb across a hump, so the
    // hump wins; a word break at é would hand it a boundary bonus instead.
    expect(fuzzyScore('ab', 'éab')).toBe(36)
    expect(fuzzyScore('ab', 'zAb')).toBe(53)
  })
})

describe('fuzzyScore single characters', () => {
  /**
   * fzf answers a one-character fragment at the first word boundary it meets,
   * because its scan is built to stop early. This scorer reads every position
   * and keeps the best, so a boundary that sits later can still win; the
   * divergence is deliberate and pinned rather than left to drift.
   */
  it('keeps the best hit instead of the first boundary fzf would stop at', () => {
    expect(fuzzyScore('a', '-a a')).toBe(36)
    expect(fuzzyScore('a', 'x/a')).toBe(34)
  })
})
