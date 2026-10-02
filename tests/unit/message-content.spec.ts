/** Large durable blocks must preserve recorded order without exceeding engine argument limits. */
import { describe, expect, it } from 'vitest'
import { contentLinesOf, reasoningTextsOf } from '@/transcript/message-content.ts'

const LARGE_BLOCK_COUNT = 150_000

describe('durable message content', () => {
  it('preserves nested visible lines and excludes recorded reasoning', () => {
    const nested = Array.from({ length: LARGE_BLOCK_COUNT }, (_, index) => ({ type: 'text', text: String(index) }))
    const lines = contentLinesOf([
      { type: 'text', text: 'before', content: nested },
      { type: 'reasoning', text: 'private' },
      { type: 'text', text: 'after' },
    ])
    expect(lines).toEqual(['before', ...nested.map(block => block.text), 'after'])
  })

  it('preserves nested recorded thoughts without including visible answer text', () => {
    const nested = Array.from({ length: LARGE_BLOCK_COUNT }, (_, index) => ({ type: 'reasoning', text: String(index) }))
    const thoughts = reasoningTextsOf([
      { type: 'reasoning', text: 'before' },
      { type: 'tool-result', content: nested },
      { type: 'text', text: 'answer' },
      { type: 'reasoning', text: 'after' },
    ])
    expect(thoughts).toEqual(['before', ...nested.map(block => block.text), 'after'])
  })
})
