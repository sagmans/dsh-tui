import { describe, expect, it } from 'vitest'
import { matchScore } from '@/input/match.ts'

describe('matchScore', () => {
  it('takes an empty filter as no narrowing at all', () => {
    expect(matchScore('', 'GLM-5.3')).toBeDefined()
    expect(matchScore('   ', 'GLM-5.3')).toBeDefined()
  })

  it('matches a fragment the reader types without the punctuation', () => {
    expect(matchScore('glm53', 'zai-coding-cn glm-5.3 GLM-5.3')).toBeDefined()
  })

  it('refuses a fragment whose characters are not all there in order', () => {
    expect(matchScore('glm53', 'kimi-coding k2 K2')).toBeUndefined()
    expect(matchScore('53glm', 'zai-coding-cn glm-5.3')).toBeUndefined()
  })

  it('ranks exact over prefix over contiguous over scattered', () => {
    const exact = matchScore('glm-5.3', 'glm-5.3')
    const prefix = matchScore('glm', 'glm-5.3 extra')
    const contiguous = matchScore('glm', 'zai glm-5.3')
    const scattered = matchScore('glm53', 'glm-5.3')
    expect(exact).toBeGreaterThan(prefix ?? 0)
    expect(prefix).toBeGreaterThan(contiguous ?? 0)
    expect(contiguous).toBeGreaterThan(scattered ?? 0)
  })

  it('prefers a contiguous hit that starts earlier in the row', () => {
    const early = matchScore('glm', 'glm-5.3 zai')
    const late = matchScore('glm', 'zai-coding-cn glm-5.3')
    expect(early).toBeGreaterThan(late ?? 0)
  })

  it('needs a long enough fragment before it gathers scattered characters', () => {
    expect(matchScore('gz', 'zai-coding-cn glm-5.3')).toBeUndefined()
    expect(matchScore('gm5', 'zai-coding-cn glm-5.3')).toBeDefined()
  })

  it('prefers the fragment whose characters sit closest together', () => {
    // fzf weighs a word start above raw tightness — g-x-l-m-5-3 outranks
    // xglm-5.3 — so the pair here keeps the boundaries equal and tests the
    // tightness itself.
    const tight = matchScore('abc', 'a-b-c')
    const spread = matchScore('abc', 'a--b--c')
    expect(tight).toBeGreaterThan(spread ?? 0)
  })

  it('does not settle for the first character the row happens to show', () => {
    const worse = matchScore('glm53', 'kimi-coding g-l-m-5-3')
    const better = matchScore('glm53', 'zai-coding-cn glm-5.3')
    expect(better).toBeGreaterThan(worse ?? 0)
  })

it('reads a fragment the way a fuzzy finder does inside its band', () => {
    // fzf ranks out-of-bound above foobar for this fragment: the run starts on
    // a word boundary even though the whole match is spread further.
    const boundary = matchScore('oob', 'out-of-bound')
    const inline = matchScore('oob', 'xoutofboundx')
    expect(boundary).toBeGreaterThan(inline ?? 0)
  })

  it('still keeps a contiguous band above a scattered one', () => {
    const contiguous = matchScore('foob', 'foobar')
    const scattered = matchScore('foob', 'foo-bar')
    expect(contiguous).toBeGreaterThan(scattered ?? 0)
  })


  it('ignores case', () => {
    expect(matchScore('GLM53', 'zai-coding-cn glm-5.3')).toBeDefined()
  })

  it('keeps a camel hump above the same letters without one', () => {
    expect(matchScore('fbb', 'fooBarBaz')).toBeGreaterThan(matchScore('fbb', 'foobarbaz') ?? 0)
  })

  it('matches letters that fold to one code point apiece', () => {
    expect(matchScore('Σ', 'ΟΣ')).toBeGreaterThan(0)
  })
})
