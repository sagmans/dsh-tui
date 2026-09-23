import { describe, expect, it } from 'vitest'
import {
  cardDetailRows,
  CARD_DETAIL_MAX,
  CARD_LINE_LIMIT,
  CARD_SHELL_PREVIEW,
  cardOfCall,
  cardOfResult,
  carriedFields,
  clip,
  mergeCards,
  renderFileDiff,
  rowText,
  shellFoldHint,
  shellRetentionHint,
  subCallRow,
  subCallRows,
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
    expect(cardOfCall(undefined, 'mystery')).toEqual({ kind: 'generic', tool: 'mystery', title: 'mystery', detail: [], failed: false, totalLines: 0 })
  })

  it('names the tool in the header and keeps the command as its own field', () => {
    const card = cardOfCall({ card: 'terminal', title: 'ls -la', description: 'list files', cwd: '/tmp' }, 'bash')
    // The tool is what the reader's per-tool display settings are keyed by.
    expect(card.tool).toBe('bash')
    expect(card.title).toBe('bash')
    expect(card.argument).toBe('ls -la')
    expect(texts(card.detail)).toEqual(['list files', 'cwd /tmp'])
    expect(card.detail.map(line => line.parts[0]?.class)).toEqual(['output', 'cwd'])
  })

  it('names a file call by its tool and puts the path in the argument', () => {
    const card = cardOfCall({ card: 'diff', title: 'Write a.txt', diffs: [{ path: 'a.txt', oldText: null, newText: 'x' }] }, 'write')
    expect(card.kind).toBe('diff')
    expect(card.title).toBe('write')
    expect(card.argument).toBe('a.txt')
    expect(texts(card.detail)).toEqual(['a.txt  new', '+x'])
  })

  it('takes a generic call path from its declared locations', () => {
    const card = cardOfCall({ card: 'generic', title: 'Read a.ts (from line 5)', kind: 'read', locations: [{ path: 'a.ts', line: 5 }] }, 'read')
    expect(card.title).toBe('read')
    expect(card.argument).toBe('a.ts')
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

  it('drops a presenter verb that only restates the call', () => {
    const card = cardOfCall({ card: 'generic', title: 'Load skill project-skill', kind: 'read', rawInput: 'project-skill' }, 'skill')
    expect(card.title).toBe('skill project-skill')
  })
})

describe('cardDetailRows', () => {
  const card = (rows: number, kind: ToolCard['kind'] = 'generic'): ToolCard => ({
    kind,
    tool: 'flood',
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
    const shown = cardDetailRows(card(25, 'terminal'), { expanded: false, preview: 'tail', rows: CARD_SHELL_PREVIEW })
    expect(texts(shown.lines).at(0)).toBe(`line ${25 - CARD_SHELL_PREVIEW}`)
    expect(texts(shown.lines).at(-1)).toBe('line 24')
    expect(shown.hidden).toBe(25 - CARD_SHELL_PREVIEW)
    expect(shellFoldHint(shown.hidden, 'ctrl+o')).toBe('… 5 earlier lines · ctrl+o shows more')
    // The key in the hint is the reader's, so a card opened by another key says so.
    expect(shellFoldHint(shown.hidden, 'ctrl+t')).toBe('… 5 earlier lines · ctrl+t shows more')
  })

  it('names an opened shell card\'s dropped rows as the earlier ones', () => {
    // Retention keeps the tail, so an opened card is missing its beginning; a
    // hint that only counts rows sends the reader past the end of the output.
    expect(shellRetentionHint(4800)).toBe('… 4800 earlier lines not shown')
    expect(shellRetentionHint(0)).toBeUndefined()
  })

  it("keeps a shell card's whole output when it fits the preview", () => {
    const shown = cardDetailRows(card(3, 'terminal'), { expanded: false, preview: 'tail', rows: CARD_SHELL_PREVIEW })
    expect(shown.lines).toHaveLength(3)
    expect(shown.hidden).toBe(0)
    expect(shellFoldHint(shown.hidden, 'ctrl+o')).toBeUndefined()
  })

  it('keeps exactly the tail the reader asked for, and none at zero', () => {
    // A count of zero must keep nothing: a negative window would otherwise read
    // as "from the end", which in JavaScript means the whole array.
    expect(texts(cardDetailRows(card(25), { expanded: false, preview: 'tail', rows: 3 }).lines)).toEqual(['line 22', 'line 23', 'line 24'])
    expect(cardDetailRows(card(25), { expanded: false, preview: 'tail', rows: 0 }).lines).toHaveLength(0)
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
  it('renders a terminal result with its exit status kept out of the output rows', () => {
    const card = cardOfResult({ card: 'terminal', title: 'ls', output: 'a\nb', exitCode: 0 }, { name: 'bash', failed: false, contentLines: [] })
    // The header is the tool, the result title is the command fallback, and the
    // pill is its own field so it never consumes a folded output slot.
    expect(card.title).toBe('bash')
    expect(card.argument).toBe('ls')
    expect(card.status).toBe('exit 0')
    expect(texts(card.detail)).toEqual(['a', 'b'])
  })

  it('does not spend a preview row on a terminating newline', () => {
    const card = cardOfResult({ card: 'terminal', output: 'a\nb\n', exitCode: 0 }, { name: 'bash', failed: false, contentLines: [] })
    expect(texts(card.detail)).toEqual(['a', 'b'])
    expect(card.totalLines).toBe(2)
  })

  it('keeps the true tail and the status of output far past retention', () => {
    const flood = Array.from({ length: 5000 }, (_, index) => `row ${index}`)
    const card = cardOfResult(
      { card: 'terminal', output: flood.join('\n'), exitCode: 3 },
      { name: 'bash', failed: false, contentLines: [] },
    )
    expect(card.detail).toHaveLength(CARD_DETAIL_MAX)
    expect(rowText(card.detail.at(-1) as CardRow)).toBe('row 4999')
    expect(card.status).toBe('exit 3')
    expect(card.totalLines).toBe(5000)
    // Folded, the preview is the run's real tail, not the end of a retained head.
    const shown = cardDetailRows(card, { expanded: false, preview: 'tail', rows: CARD_SHELL_PREVIEW })
    expect(texts(shown.lines).at(0)).toBe(`row ${5000 - CARD_SHELL_PREVIEW}`)
    expect(texts(shown.lines).at(-1)).toBe('row 4999')
    expect(shown.hidden).toBe(5000 - CARD_SHELL_PREVIEW)
  })

  it('marks a failed result so the reader sees it without expanding', () => {
    const card = cardOfResult(undefined, { name: 'bash', failed: true, contentLines: ['boom'] })
    expect(card).toEqual({ kind: 'generic', tool: 'bash', title: 'bash', detail: [row('detail', 'boom')], failed: true, totalLines: 1 })
  })

  it('renders search matches with their file and line', () => {
    const card = cardOfResult(
      { card: 'search', shape: 'matches', files: [{ path: 'a.ts', matches: [{ lineNumber: 3, line: 'hit' }] }], truncated: true, total: 9 },
      { name: 'grep', failed: false, contentLines: [] },
    )
    expect(texts(card.detail)).toEqual(['a.ts:3: hit', '… 9 total'])
    // The location and the matching line are separate elements on one row.
    expect(card.detail[0]?.parts.map(part => part.class)).toEqual(['path', 'lineNumber', 'match'])
  })

  it('renders path-shaped search results', () => {
    const card = cardOfResult(
      { card: 'search', shape: 'paths', paths: ['a.ts', 'b.ts'], truncated: false, total: 2 },
      { name: 'glob', failed: false, contentLines: [] },
    )
    expect(texts(card.detail)).toEqual(['a.ts', 'b.ts'])
  })

  it('reports a read result as its path, range, size, and numbered lines', () => {
    const card = cardOfResult(
      { card: 'read', path: 'a.ts', offset: 5, lines: [{ number: 5, text: 'x' }], totalLines: 20 },
      { name: 'read', failed: false, contentLines: [] },
    )
    expect(card.title).toBe('read')
    expect(card.argument).toBe('a.ts')
    expect(card.stats).toEqual([
      { kind: 'size', text: 'L5' },
      { kind: 'size', text: '1 line' },
      { kind: 'size', text: '1 tok' },
    ])
    expect(texts(card.detail)).toEqual(['5: x'])
    expect(card.detail[0]?.parts.map(part => part.class)).toEqual(['lineNumber', 'line'])
  })

  it('reports the whole range a multi-line read spans', () => {
    const card = cardOfResult(
      { card: 'read', path: 'a.ts', offset: 5, lines: [{ number: 5, text: 'x' }, { number: 6, text: 'y' }, { number: 7, text: 'z' }], totalLines: 20 },
      { name: 'read', failed: false, contentLines: [] },
    )
    expect(card.stats?.slice(0, 2)).toEqual([{ kind: 'size', text: 'L5–7' }, { kind: 'size', text: '3 lines' }])
  })

  it('keeps a read window\'s offset when it returned no lines', () => {
    // The view preserves the offset for exactly this case, so the card must not
    // drop it and leave the reader without a place to continue from.
    const card = cardOfResult(
      { card: 'read', path: 'a.ts', offset: 400, lines: [], totalLines: 900 },
      { name: 'read', failed: false, contentLines: [] },
    )
    expect(card.stats).toEqual([{ kind: 'size', text: 'L400' }, { kind: 'size', text: '0 lines' }])
  })

  it('measures the content a read falls back to drawing', () => {
    // A read with no numbered window still draws its model-facing content, so a
    // size of zero would contradict the rows under the header.
    const card = cardOfResult(
      { card: 'read', path: 'a.ts', offset: 1, lines: [], totalLines: 3, content: [{ type: 'text', text: 'one\ntwo' }] },
      { name: 'read', failed: false, contentLines: [] },
    )
    expect(card.stats).toEqual([
      { kind: 'size', text: 'L1–2' },
      { kind: 'size', text: '2 lines' },
      { kind: 'size', text: '2 tok' },
    ])
    expect(texts(card.detail)).toEqual(['one', 'two'])
  })

  it('reports a new file by its line and token size', () => {
    const card = cardOfResult(
      { card: 'diff', diffs: [{ path: 'a.txt', oldText: null, newText: 'one\ntwo\nthree' }] },
      { name: 'write', failed: false, contentLines: [] },
    )
    expect(card.title).toBe('write')
    expect(card.argument).toBe('a.txt')
    expect(card.stats).toEqual([
      { kind: 'size', text: '3 lines' },
      { kind: 'size', text: '4 tok' },
    ])
  })

  it('reports an edit as one changed line, not an add plus a remove', () => {
    const card = cardOfResult(
      { card: 'diff', diffs: [{ path: 'a.ts', oldText: 'keep\nold\ntail', newText: 'keep\nnew\ntail' }] },
      { name: 'edit', failed: false, contentLines: [] },
    )
    expect(card.stats).toEqual([{ kind: 'changed', text: '1' }])
  })

  it('separates pure additions from replacements', () => {
    const card = cardOfResult(
      { card: 'diff', diffs: [{ path: 'a.ts', oldText: 'a\nb', newText: 'a\nx\ny' }] },
      { name: 'edit', failed: false, contentLines: [] },
    )
    // `b -> x` is a change and `y` is the only pure addition.
    expect(card.stats).toEqual([{ kind: 'added', text: '1' }, { kind: 'changed', text: '1' }])
  })

  it("nets each file's change on its own", () => {
    // One file's additions must not cancel another's deletions: netting across
    // files would report a two-file change as a rewrite of neither.
    const card = cardOfResult(
      {
        card: 'diff',
        diffs: [
          { path: 'a.ts', oldText: 'keep', newText: 'keep\none\ntwo' },
          { path: 'b.ts', oldText: 'keep\none\ntwo', newText: 'keep' },
        ],
      },
      { name: 'edit', failed: false, contentLines: [] },
    )
    expect(card.stats).toEqual([{ kind: 'added', text: '2' }, { kind: 'removed', text: '2' }])
  })

  it('renders both web shapes', () => {
    const search = cardOfResult(
      { card: 'web', kind: 'search', sources: [{ url: 'https://x', title: 'X' }], answer: 'yes', truncated: false },
      { name: 'web_search', failed: false, contentLines: [] },
    )
    expect(texts(search.detail)).toEqual(['yes', 'X — https://x'])
    const fetch = cardOfResult(
      { card: 'web', kind: 'fetch', url: 'https://x', statusCode: 200, truncated: true },
      { name: 'web_fetch', failed: false, contentLines: [] },
    )
    expect(texts(fetch.detail)).toEqual(['https://x → 200', '… body truncated'])
  })

  it('keeps a flood of rows bounded in memory', () => {
    const flood = Array.from({ length: 5000 }, (_, index) => `row ${index}`)
    const card = cardOfResult(undefined, { name: 'bash', failed: false, contentLines: flood })
    expect(card.detail).toHaveLength(CARD_DETAIL_MAX)
    expect(card.totalLines).toBe(5000)
  })
})

describe('mergeCards', () => {
  const call: ToolCard = { kind: 'terminal', tool: 'bash', title: 'bash', argument: 'ls -la', detail: [row('cwd', 'cwd /tmp')], failed: false, totalLines: 1 }

  it('keeps the call header and command while swapping in the result', () => {
    const result: ToolCard = { kind: 'terminal', tool: 'bash', title: 'bash', detail: [row('output', 'a'), row('output', 'b')], failed: false, totalLines: 2 }
    expect(mergeCards(call, result)).toEqual({
      kind: 'terminal',
      tool: 'bash',
      title: 'bash',
      argument: 'ls -la',
      detail: [row('output', 'a'), row('output', 'b')],
      failed: false,
      totalLines: 2,
    })
  })

  it('keeps the call detail when the result presents nothing', () => {
    const result: ToolCard = { kind: 'generic', tool: 'ls', title: 'ls', detail: [], failed: true, totalLines: 0 }
    expect(mergeCards(call, result)).toEqual({
      kind: 'terminal',
      tool: 'bash',
      title: 'bash',
      argument: 'ls -la',
      detail: [row('cwd', 'cwd /tmp')],
      failed: true,
      totalLines: 1,
    })
  })

  it('carries the result status and stats onto the merged card', () => {
    const result: ToolCard = { kind: 'terminal', tool: 'bash', title: 'bash', status: 'exit 2', stats: [{ kind: 'size', text: '3 lines' }], detail: [row('output', 'boom')], failed: true, totalLines: 1 }
    expect(mergeCards(call, result).status).toBe('exit 2')
    expect(mergeCards(call, result).stats).toEqual([{ kind: 'size', text: '3 lines' }])
  })

  it("prefers the result's argument when the merged kind changes", () => {
    // A diff result knows the file it changed; the pending command must not
    // stand in for it on a card that is no longer a terminal.
    const result: ToolCard = { kind: 'diff', tool: 'edit', title: 'edit', argument: 'a.ts', detail: [row('added', '+x')], failed: false, totalLines: 1 }
    const merged = mergeCards(call, result)
    expect(merged.kind).toBe('diff')
    expect(merged.argument).toBe('a.ts')
  })

  it('returns the single available card when only one side exists', () => {
    expect(mergeCards(undefined, call)).toBe(call)
    expect(mergeCards(call, undefined)).toBe(call)
  })

  it('refuses to merge two absent cards', () => {
    expect(() => mergeCards(undefined, undefined)).toThrow(/at least one card/)
  })
})

describe('carriedFields', () => {
  it('keeps the header fields a rebuilt card would otherwise lose', () => {
    // A rebuild replaces the rows and says nothing about the command, the facts,
    // or the outcome, so all three have to travel with it.
    const card: ToolCard = {
      kind: 'terminal',
      tool: 'bash',
      title: 'bash',
      argument: 'ls -la',
      stats: [{ kind: 'size', text: '3 lines' }],
      status: 'exit 0',
      detail: [],
      failed: false,
      totalLines: 0,
    }
    expect(carriedFields(card)).toEqual({
      argument: 'ls -la',
      stats: [{ kind: 'size', text: '3 lines' }],
      status: 'exit 0',
    })
  })

  it('omits a field the card never had', () => {
    const card: ToolCard = { kind: 'generic', tool: 'read', title: 'read', detail: [], failed: false, totalLines: 0 }
    expect(carriedFields(card)).toEqual({})
  })

  it('carries the nested calls a PTC program dispatched', () => {
    const card: ToolCard = {
      kind: 'generic',
      tool: 'run_code',
      title: 'run_code',
      detail: [],
      failed: false,
      totalLines: 0,
      subCalls: [{ id: 's1', title: 'read', argument: 'a.ts', failed: false, running: false }],
      subCallsTotal: 1,
    }
    expect(carriedFields(card)).toEqual({
      subCalls: [{ id: 's1', title: 'read', argument: 'a.ts', failed: false, running: false }],
      subCallsTotal: 1,
    })
  })
})

describe('subCallRow', () => {
  it('draws the tool view the presenter declared', () => {
    const view: ToolCard = { kind: 'terminal', tool: 'bash', title: 'bash', argument: 'git status', detail: [], failed: false, totalLines: 0 }
    expect(subCallRow('s1', 'bash', '{"command":"git status"}', view, undefined, undefined, true, false)).toEqual({ id: 's1', title: 'bash', argument: 'git status', failed: false, running: true })
  })

  it('falls back to the registry name and the raw call when no view answers', () => {
    expect(subCallRow('s2', 'mystery', '{"a":1}', undefined, undefined, undefined, false, false)).toEqual({ id: 's2', title: 'mystery', argument: '{"a":1}', failed: false, running: false })
    expect(subCallRow('s3', 'mystery', '', undefined, undefined, undefined, false, false)).toEqual({ id: 's3', title: 'mystery', failed: false, running: false })
  })

  it('drops a whole grapheme rather than half of a joined emoji', () => {
    // The budget counts graphemes, so the cut can only fall between clusters.
    expect(clip('ab👨‍👩‍👧cd', 4)).toBe('ab👨‍👩‍👧…')
    expect(clip('ab👨‍👩‍👧cd', 3)).toBe('ab…')
    expect(clip('abc', 3)).toBe('abc')
    expect(clip('abc', 0)).toBe('')
  })

  it('clips a raw call so an oversized argument cannot fill the row', () => {
    const call = subCallRow('s4', 'mystery', `{"a":"${'x'.repeat(500)}"}`, undefined, undefined, undefined, false, false)
    expect(call.argument?.length).toBeLessThanOrEqual(CARD_LINE_LIMIT)
  })
})

describe('subCallRows', () => {
  it('keeps the rows a card drew, with its kind, for the row a click opens', () => {
    const view = cardOfCall({ card: 'diff', title: 'Edit', diffs: [{ path: 'a.txt', oldText: 'b', newText: 'B' }] }, 'edit')
    expect(subCallRows(view)).toEqual({ kind: 'diff', rows: view.detail, totalLines: view.detail.length })
    expect(texts(subCallRows(view)?.rows ?? [])).toEqual(['a.txt  -1 +1', '-b', '+B'])
  })

  it('clamps a total below the rows kept, so no hint counts rows already shown', () => {
    // A call view keeps its rows without reporting a total of its own: the
    // terminal branch is the shipped case that reports zero.
    const terminal = cardOfCall({ card: 'terminal', title: 'ls', cwd: '/tmp' }, 'bash')
    expect(terminal.totalLines).toBe(0)
    expect(subCallRows(terminal)?.totalLines).toBe(terminal.detail.length)
  })

  it('has no section for a card that kept no rows', () => {
    expect(subCallRows(undefined)).toBeUndefined()
    expect(subCallRows(cardOfCall(undefined, 'mystery'))).toBeUndefined()
  })
})
