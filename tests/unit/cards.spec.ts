import { describe, expect, it } from 'vitest'
import { cardOfCall, cardOfResult, mergeCards, renderFileDiff, type ToolCard } from '@/cards.ts'

describe('renderFileDiff', () => {
  it('renders a new file as additions only', () => {
    const lines = renderFileDiff({ path: 'a.txt', oldText: null, newText: 'one\ntwo' })
    expect(lines).toEqual(['a.txt  new', '+one', '+two'])
  })

  it('shows only the changed middle of an edit', () => {
    const lines = renderFileDiff({ path: 'a.txt', oldText: 'keep\nbefore\ntail', newText: 'keep\nafter\ntail' })
    expect(lines).toEqual(['a.txt  -1 +1', '@@ 1 unchanged line before', '-before', '+after', '@@ 1 unchanged line after'])
  })

  it('reports an unchanged file as a no-op hunk', () => {
    const lines = renderFileDiff({ path: 'a.txt', oldText: 'same', newText: 'same' })
    expect(lines).toEqual(['a.txt  -0 +0', '@@ 1 unchanged line before'])
  })
})

describe('cardOfCall', () => {
  it('falls back to a generic card when the tool declares no view', () => {
    expect(cardOfCall(undefined, 'mystery')).toEqual({ kind: 'generic', title: 'mystery', detail: [], failed: false, hiddenLines: 0 })
  })

  it('maps a terminal call to its command and working directory', () => {
    const card = cardOfCall({ card: 'terminal', title: 'ls -la', description: 'list files', cwd: '/tmp' }, 'bash')
    expect(card).toEqual({ kind: 'terminal', title: 'ls -la', detail: ['list files', 'cwd /tmp'], failed: false, hiddenLines: 0 })
  })

  it('maps a diff call to bounded diff lines', () => {
    const card = cardOfCall({ card: 'diff', title: 'Write a.txt', diffs: [{ path: 'a.txt', oldText: null, newText: 'x' }] }, 'write')
    expect(card.kind).toBe('diff')
    expect(card.detail).toEqual(['a.txt  new', '+x'])
  })

  it('uses the declared title and bounds oversized detail', () => {
    const long = Array.from({ length: 25 }, (_, index) => `line ${index}`)
    const card = cardOfCall({ card: 'generic', title: 'Read many', content: [{ type: 'text', text: long.join('\n') }] }, 'read')
    expect(card.title).toBe('Read many')
    expect(card.detail).toHaveLength(10)
    expect(card.hiddenLines).toBe(15)
  })

  it('falls back to the tool name when a view declares no title', () => {
    expect(cardOfCall({ card: 'generic', title: '  ' }, 'grep').title).toBe('grep')
  })
})

describe('cardOfResult', () => {
  it('renders a terminal result with its exit status', () => {
    const card = cardOfResult({ card: 'terminal', title: 'ls', output: 'a\nb', exitCode: 0 }, { fallbackTitle: 'bash', failed: false, contentLines: [] })
    expect(card.detail).toEqual(['a', 'b', 'exit 0'])
  })

  it('marks a failed result so the reader sees it without expanding', () => {
    const card = cardOfResult(undefined, { fallbackTitle: 'bash', failed: true, contentLines: ['boom'] })
    expect(card).toEqual({ kind: 'generic', title: 'bash', detail: ['boom'], failed: true, hiddenLines: 0 })
  })

  it('renders search matches with their file and line', () => {
    const card = cardOfResult(
      { card: 'search', shape: 'matches', files: [{ path: 'a.ts', matches: [{ lineNumber: 3, line: 'hit' }] }], truncated: true, total: 9 },
      { fallbackTitle: 'grep', failed: false, contentLines: [] },
    )
    expect(card.detail).toEqual(['a.ts:3: hit', '… 9 total'])
  })

  it('renders path-shaped search results', () => {
    const card = cardOfResult(
      { card: 'search', shape: 'paths', paths: ['a.ts', 'b.ts'], truncated: false, total: 2 },
      { fallbackTitle: 'glob', failed: false, contentLines: [] },
    )
    expect(card.detail).toEqual(['a.ts', 'b.ts'])
  })

  it('renders a read result with its range header', () => {
    const card = cardOfResult(
      { card: 'read', path: 'a.ts', offset: 5, lines: [{ number: 5, text: 'x' }], totalLines: 20 },
      { fallbackTitle: 'read', failed: false, contentLines: [] },
    )
    expect(card.detail).toEqual(['a.ts (from line 5, 20 total)', '5: x'])
  })

  it('renders both web shapes', () => {
    const search = cardOfResult(
      { card: 'web', kind: 'search', sources: [{ url: 'https://x', title: 'X' }], answer: 'yes', truncated: false },
      { fallbackTitle: 'web_search', failed: false, contentLines: [] },
    )
    expect(search.detail).toEqual(['yes', 'X — https://x'])
    const fetch = cardOfResult(
      { card: 'web', kind: 'fetch', url: 'https://x', statusCode: 200, truncated: true },
      { fallbackTitle: 'web_fetch', failed: false, contentLines: [] },
    )
    expect(fetch.detail).toEqual(['https://x → 200', '… body truncated'])
  })
})

describe('mergeCards', () => {
  const call: ToolCard = { kind: 'terminal', title: 'ls -la', detail: ['cwd /tmp'], failed: false, hiddenLines: 0 }

  it('keeps the call header and swaps in the result', () => {
    const result: ToolCard = { kind: 'terminal', title: 'ls', detail: ['a', 'b'], failed: false, hiddenLines: 0 }
    expect(mergeCards(call, result)).toEqual({ kind: 'terminal', title: 'ls -la', detail: ['a', 'b'], failed: false, hiddenLines: 0 })
  })

  it('keeps the call detail when the result presents nothing', () => {
    const result: ToolCard = { kind: 'generic', title: 'ls', detail: [], failed: true, hiddenLines: 0 }
    expect(mergeCards(call, result)).toEqual({ kind: 'terminal', title: 'ls -la', detail: ['cwd /tmp'], failed: true, hiddenLines: 0 })
  })

  it('returns the single available card when only one side exists', () => {
    expect(mergeCards(undefined, call)).toBe(call)
    expect(mergeCards(call, undefined)).toBe(call)
  })

  it('refuses to merge two absent cards', () => {
    expect(() => mergeCards(undefined, undefined)).toThrow(/at least one card/)
  })
})
