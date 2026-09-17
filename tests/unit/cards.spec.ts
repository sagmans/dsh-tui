import { describe, expect, it } from 'vitest'
import {
  cardDetailRows,
  CARD_DETAIL_MAX,
  CARD_SHELL_PREVIEW,
  cardOfCall,
  cardOfResult,
  mergeCards,
  renderFileDiff,
  rowText,
  shellPreviewHint,
  type CardRow,
  type ToolCard,
} from '@/cards.ts'

/** The words of each row, which is what most assertions are about. */
const texts = (rows: readonly CardRow[]): string[] => rows.map(rowText)

/** A single-style row, for building expected cards without ceremony. */
const row = (cls: CardRow['parts'][number]['class'], text: string): CardRow => ({ parts: [{ class: cls, text }] })

describe('renderFileDiff', () => {
  it('renders a new file as additions only', () => {
    const lines = renderFileDiff({ path: 'a.txt', oldText: null, newText: 'one\ntwo' })
    expect(texts(lines)).toEqual(['a.txt  new', '+one', '+two'])
  })

  it('tags every row with what the presenter knows it to be', () => {
    const lines = renderFileDiff({ path: 'a.txt', oldText: 'keep\nbefore\ntail', newText: 'keep\nafter\ntail' })
    expect(lines.map(line => line.parts[0]?.class)).toEqual(['header', 'hunk', 'removed', 'added', 'hunk'])
  })

  it('shows only the changed middle of an edit', () => {
    const lines = renderFileDiff({ path: 'a.txt', oldText: 'keep\nbefore\ntail', newText: 'keep\nafter\ntail' })
    expect(texts(lines)).toEqual(['a.txt  -1 +1', '@@ 1 unchanged line before', '-before', '+after', '@@ 1 unchanged line after'])
  })

  it('reports an unchanged file as a no-op hunk', () => {
    const lines = renderFileDiff({ path: 'a.txt', oldText: 'same', newText: 'same' })
    expect(texts(lines)).toEqual(['a.txt  -0 +0', '@@ 1 unchanged line before'])
  })
})

describe('cardOfCall', () => {
  it('falls back to a generic card when the tool declares no view', () => {
    expect(cardOfCall(undefined, 'mystery')).toEqual({ kind: 'generic', title: 'mystery', detail: [], failed: false, totalLines: 0 })
  })

  it('maps a terminal call to its command and working directory', () => {
    const card = cardOfCall({ card: 'terminal', title: 'ls -la', description: 'list files', cwd: '/tmp' }, 'bash')
    expect(texts(card.detail)).toEqual(['list files', 'cwd /tmp'])
    expect(card.detail.map(line => line.parts[0]?.class)).toEqual(['output', 'cwd'])
  })

  it('maps a diff call to bounded diff lines', () => {
    const card = cardOfCall({ card: 'diff', title: 'Write a.txt', diffs: [{ path: 'a.txt', oldText: null, newText: 'x' }] }, 'write')
    expect(card.kind).toBe('diff')
    expect(texts(card.detail)).toEqual(['a.txt  new', '+x'])
  })

  it('uses the declared title and counts every presented row', () => {
    const long = Array.from({ length: 25 }, (_, index) => `line ${index}`)
    const card = cardOfCall({ card: 'generic', title: 'Read many', content: [{ type: 'text', text: long.join('\n') }] }, 'read')
    expect(card.title).toBe('Read many')
    expect(card.detail).toHaveLength(25)
    expect(card.totalLines).toBe(25)
  })

  it('falls back to the tool name when a view declares no title', () => {
    expect(cardOfCall({ card: 'generic', title: '  ' }, 'grep').title).toBe('grep')
  })
})

describe('cardDetailRows', () => {
  const card = (rows: number, kind: ToolCard['kind'] = 'generic'): ToolCard => ({
    kind,
    title: 'flood',
    detail: Array.from({ length: rows }, (_, index) => row('detail', `line ${index}`)),
    failed: false,
    totalLines: rows,
  })

  it('draws no detail row while a card is folded to its title', () => {
    const shown = cardDetailRows(card(25), { expanded: false, preview: 'title' })
    expect(shown.lines).toHaveLength(0)
    expect(shown.hidden).toBe(25)
  })

  it('keeps the tail of a folded shell card and counts the rows before it', () => {
    const shown = cardDetailRows(card(25, 'terminal'), { expanded: false, preview: 'shellTail' })
    expect(texts(shown.lines).at(0)).toBe(`line ${25 - CARD_SHELL_PREVIEW}`)
    expect(texts(shown.lines).at(-1)).toBe('line 24')
    expect(shown.hidden).toBe(25 - CARD_SHELL_PREVIEW)
    expect(shellPreviewHint(shown.hidden)).toBe('… 5 earlier lines · ctrl+o shows them')
  })

  it("keeps a shell card's whole output when it fits the preview", () => {
    const shown = cardDetailRows(card(3, 'terminal'), { expanded: false, preview: 'shellTail' })
    expect(shown.lines).toHaveLength(3)
    expect(shown.hidden).toBe(0)
    expect(shellPreviewHint(shown.hidden)).toBeUndefined()
  })

  it('shows every retained row while expanded', () => {
    const shown = cardDetailRows(card(25), { expanded: true })
    expect(shown.lines).toHaveLength(25)
    expect(shown.hidden).toBe(0)
  })

  it('stays bounded for a card that streamed far more than it keeps', () => {
    const shown = cardDetailRows({ ...card(0), detail: [], totalLines: 5000 }, { expanded: true })
    expect(shown.lines).toHaveLength(0)
    expect(shown.hidden).toBe(5000)
  })
})

describe('cardOfResult', () => {
  it('renders a terminal result with its exit status', () => {
    const card = cardOfResult({ card: 'terminal', title: 'ls', output: 'a\nb', exitCode: 0 }, { fallbackTitle: 'bash', failed: false, contentLines: [] })
    expect(texts(card.detail)).toEqual(['a', 'b', 'exit 0'])
    expect(card.detail.map(line => line.parts[0]?.class)).toEqual(['output', 'output', 'status'])
  })

  it('marks a failed result so the reader sees it without expanding', () => {
    const card = cardOfResult(undefined, { fallbackTitle: 'bash', failed: true, contentLines: ['boom'] })
    expect(card).toEqual({ kind: 'generic', title: 'bash', detail: [row('detail', 'boom')], failed: true, totalLines: 1 })
  })

  it('renders search matches with their file and line', () => {
    const card = cardOfResult(
      { card: 'search', shape: 'matches', files: [{ path: 'a.ts', matches: [{ lineNumber: 3, line: 'hit' }] }], truncated: true, total: 9 },
      { fallbackTitle: 'grep', failed: false, contentLines: [] },
    )
    expect(texts(card.detail)).toEqual(['a.ts:3: hit', '… 9 total'])
    // The location and the matching line are separate elements on one row.
    expect(card.detail[0]?.parts.map(part => part.class)).toEqual(['path', 'lineNumber', 'match'])
  })

  it('renders path-shaped search results', () => {
    const card = cardOfResult(
      { card: 'search', shape: 'paths', paths: ['a.ts', 'b.ts'], truncated: false, total: 2 },
      { fallbackTitle: 'glob', failed: false, contentLines: [] },
    )
    expect(texts(card.detail)).toEqual(['a.ts', 'b.ts'])
  })

  it('renders a read result with its range header', () => {
    const card = cardOfResult(
      { card: 'read', path: 'a.ts', offset: 5, lines: [{ number: 5, text: 'x' }], totalLines: 20 },
      { fallbackTitle: 'read', failed: false, contentLines: [] },
    )
    expect(texts(card.detail)).toEqual(['a.ts (from line 5, 20 total)', '5: x'])
    expect(card.detail[1]?.parts.map(part => part.class)).toEqual(['lineNumber', 'line'])
  })

  it('renders both web shapes', () => {
    const search = cardOfResult(
      { card: 'web', kind: 'search', sources: [{ url: 'https://x', title: 'X' }], answer: 'yes', truncated: false },
      { fallbackTitle: 'web_search', failed: false, contentLines: [] },
    )
    expect(texts(search.detail)).toEqual(['yes', 'X — https://x'])
    const fetch = cardOfResult(
      { card: 'web', kind: 'fetch', url: 'https://x', statusCode: 200, truncated: true },
      { fallbackTitle: 'web_fetch', failed: false, contentLines: [] },
    )
    expect(texts(fetch.detail)).toEqual(['https://x → 200', '… body truncated'])
  })

  it('keeps a flood of rows bounded in memory', () => {
    const flood = Array.from({ length: 5000 }, (_, index) => `row ${index}`)
    const card = cardOfResult(undefined, { fallbackTitle: 'bash', failed: false, contentLines: flood })
    expect(card.detail).toHaveLength(CARD_DETAIL_MAX)
    expect(card.totalLines).toBe(5000)
  })
})

describe('mergeCards', () => {
  const call: ToolCard = { kind: 'terminal', title: 'ls -la', detail: [row('cwd', 'cwd /tmp')], failed: false, totalLines: 1 }

  it('keeps the call header and swaps in the result', () => {
    const result: ToolCard = { kind: 'terminal', title: 'ls', detail: [row('output', 'a'), row('output', 'b')], failed: false, totalLines: 2 }
    expect(mergeCards(call, result)).toEqual({
      kind: 'terminal',
      title: 'ls -la',
      detail: [row('output', 'a'), row('output', 'b')],
      failed: false,
      totalLines: 2,
    })
  })

  it('keeps the call detail when the result presents nothing', () => {
    const result: ToolCard = { kind: 'generic', title: 'ls', detail: [], failed: true, totalLines: 0 }
    expect(mergeCards(call, result)).toEqual({
      kind: 'terminal',
      title: 'ls -la',
      detail: [row('cwd', 'cwd /tmp')],
      failed: true,
      totalLines: 1,
    })
  })

  it('returns the single available card when only one side exists', () => {
    expect(mergeCards(undefined, call)).toBe(call)
    expect(mergeCards(call, undefined)).toBe(call)
  })

  it('refuses to merge two absent cards', () => {
    expect(() => mergeCards(undefined, undefined)).toThrow(/at least one card/)
  })
})
