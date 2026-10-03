/** Recorded content depth must not consume the renderer's JavaScript call stack. */
import { describe, expect, it } from 'vitest'
import { contentLines } from '@/cards.ts'
import { contentLinesOf, reasoningTextsOf } from '@/transcript/message-content.ts'

const CONTENT_DEPTH = 10_000
const VISIBLE_TEXT = 'visible'
const PRIVATE_TEXT = 'private'
const READERS = [
  { name: 'durable visible lines', read: contentLinesOf, expected: [VISIBLE_TEXT] },
  { name: 'recorded thoughts', read: reasoningTextsOf, expected: [PRIVATE_TEXT] },
  { name: 'tool results', read: contentLines, expected: [VISIBLE_TEXT, PRIVATE_TEXT] },
]

describe('deep recorded content', () => {
  it.each(READERS)('reads $name without recursive stack growth', ({ read, expected }) => {
    let content: unknown[] = [{ type: 'text', text: VISIBLE_TEXT }, { type: 'reasoning', text: PRIVATE_TEXT }]
    for (let depth = 0; depth < CONTENT_DEPTH; depth++) content = [{ type: 'tool-result', content }]
    expect(read(content)).toEqual(expected)
  })
})
