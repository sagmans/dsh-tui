import { describe, expect, it } from 'vitest'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { createTheme, type TuiTheme } from '@/theme.ts'
import { DEFAULT_PALETTE, DIFF_ADDED_BAND, DIFF_REMOVED_BAND } from '@/theme-defaults.ts'
import { type StyleSpec, type TuiToken } from '@/theme-tokens.ts'
import {
  codeBlockLines,
  DIFF_EMPHASIS_MAX_GRAPHEMES,
  isDiffFence,
  plainCodeLines,
  renderDiffBlock,
  type DiffLook,
  type FenceLook,
} from '@/ui/diff.ts'

/** A colour as an escape carries it, so an assertion names the palette entry it came from. */
const rgb = (hex: string): string => [1, 3, 5].map(at => Number.parseInt(hex.slice(at, at + 2), 16)).join(';')

const added = `38;2;${rgb(DEFAULT_PALETTE.added)}`
const removed = `38;2;${rgb(DEFAULT_PALETTE.removed)}`
const muted = `38;2;${rgb(DEFAULT_PALETTE.muted)}`

/** The look the answer's markdown theme hands a fence. */
const look = (active: TuiTheme = createTheme('truecolor')): DiffLook => ({
  style: (token, text) => active.style(token, text),
  visible: token => active.visible(token),
})

/** The same look plus the language fallback, for the cases that drive a whole code block. */
const fenceLook = (active: TuiTheme = createTheme('truecolor')): FenceLook => ({
  ...look(active),
  plain: line => active.style('markdown.codeBlock', line),
})

/** A theme with one element overridden, which is how a reader turns an element off. */
const overridden = (token: TuiToken, spec: StyleSpec): TuiTheme =>
  createTheme('truecolor', { palette: DEFAULT_PALETTE, tokens: new Map([[token, spec]]) })

/** The text each band covers, read back out of a drawn row, so a run is asserted rather than its escape. */
function banded(row: string, band: string): string[] {
  const marker = `48;2;${band}`
  const found: string[] = []
  let at = 0
  while (at < row.length) {
    const start = row.indexOf(marker, at)
    if (start < 0) break
    const open = row.indexOf('m', start)
    const close = row.indexOf('\u001B[0m', open)
    found.push(row.slice(open + 1, close))
    at = close + 1
  }
  return found
}

/** One unified diff as git writes it, which is the shape a reply quotes. */
const GIT_DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1b2c3d4..5e6f7a8 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,3 @@',
  ' const keep = 1',
  '-const gone = 2',
  '+const added = 2',
].join('\n')

describe('a fenced diff', () => {
  it('names the languages that ask for one, whatever their case and info words', () => {
    for (const lang of ['diff', 'patch', 'DIFF', 'diff a/src/a.ts', ' patch ']) {
      expect(isDiffFence(lang), lang).toBe(true)
    }
    for (const lang of [undefined, '', 'ts', 'mermaid', 'diffscript']) {
      expect(isDiffFence(lang), String(lang)).toBe(false)
    }
  })

  it('recedes its scaffolding and colours its sides', () => {
    const rows = renderDiffBlock(GIT_DIFF, look())
    for (const at of [0, 1, 2, 3, 4]) {
      expect(rows[at], `row ${at} is not scaffolding`).toContain(muted)
    }
    // A file header carries the same prefix as a removed row, so this is also the
    // check that the pair of them was read as the header it is.
    expect(rows[2]).not.toContain(removed)
    expect(rows[3]).not.toContain(added)
    expect(rows[6]).toContain(removed)
    expect(rows[7]).toContain(added)
    // Unchanged code keeps the shade a fence always had, so the colour a diff adds
    // is the colour of the change and nothing else.
    expect(rows[5]).toBe(' const keep = 1')
  })

  it('reads a row that looks like a header as the content it is', () => {
    // Removed content whose text begins with "--" draws exactly like a file header.
    const lone = renderDiffBlock(['-x', '--- a comment'].join('\n'), look())
    expect(lone[1]).toContain(removed)
    // Inside a hunk every row carries a sign, so the pair rule is off there.
    const inHunk = renderDiffBlock(['@@ -1 +1 @@', '--- a comment', '+++ another'].join('\n'), look())
    expect(inHunk[1]).toContain(removed)
    expect(inHunk[1]).not.toContain(muted)
    expect(inHunk[2]).toContain(added)
  })

  it('keeps a fence of any other language exactly as the library draws it', () => {
    const active = createTheme('truecolor')
    const look = fenceLook(active)
    expect(codeBlockLines('const a = 1', 'ts', look)).toEqual(plainCodeLines('const a = 1', look.plain))
    expect(codeBlockLines('const a = 1', 'ts', look)).toEqual(['const a = 1'])
    expect(codeBlockLines('const a = 1', undefined, look)).toEqual(['const a = 1'])
    // A language that merely starts the same way is not a diff either.
    expect(codeBlockLines('+a', 'diffscript', look)).toEqual(['+a'])
  })

  it('keeps a blank context row blank', () => {
    expect(renderDiffBlock(['@@ -1 +1 @@', '', ' '].join('\n'), look())[1]).toBe('')
  })
})

/** One edit of a single row, the shape a reply shows when a line was modified rather than replaced. */
const PAIR = ['-const textWidth = visibleWidth(segment.text)', '+const textWidth = visibleWidth(drawn)'].join('\n')

describe('a paired edit', () => {
  it('bands only the characters that changed', () => {
    const rows = renderDiffBlock(PAIR, look())
    expect(banded(rows[0] ?? '', rgb(DIFF_REMOVED_BAND))).toEqual(['segment.text'])
    expect(banded(rows[1] ?? '', rgb(DIFF_ADDED_BAND))).toEqual(['drawn'])
    // Drawing a row never rewrites it: the band is a shade, not an edit.
    expect(stripTerminalSequences(rows[0] ?? '')).toBe('-const textWidth = visibleWidth(segment.text)')
    expect(stripTerminalSequences(rows[1] ?? '')).toBe('+const textWidth = visibleWidth(drawn)')
  })

  it('draws whole rows when the pair shares too little to be an edit', () => {
    const rows = renderDiffBlock(['-one', '+two'].join('\n'), look())
    expect(rows.join('')).not.toContain('48;2;')
    expect(rows[0]).toContain(removed)
    expect(rows[1]).toContain(added)
  })

  it('pairs only as many rows as both runs carry', () => {
    const rows = renderDiffBlock(['-const a = 1', '-const b = 1', '+const a = 2'].join('\n'), look())
    expect(banded(rows[0] ?? '', rgb(DIFF_REMOVED_BAND))).toEqual(['1'])
    // The row nothing answered keeps its own shade rather than being banded whole.
    expect(rows[1]).not.toContain('48;2;')
    expect(rows[1]).toContain(removed)
  })

  it('gives up the band on a pair longer than a frame should cut', () => {
    const long = 'x'.repeat(DIFF_EMPHASIS_MAX_GRAPHEMES)
    const rows = renderDiffBlock([`-${long}1`, `+${long}2`].join('\n'), look())
    expect(rows.join('')).not.toContain('48;2;')
    expect(rows[0]).toContain(removed)
    expect(rows[1]).toContain(added)
  })
})

describe('the diff elements', () => {
  it('emits nothing at all when colour is off', () => {
    expect(renderDiffBlock(GIT_DIFF, look(createTheme('none')))).toEqual(GIT_DIFF.split('\n'))
  })

  it('falls back to the row colour when the emphasis is hidden', () => {
    // An element the reader removed must not punch an unstyled hole in a row.
    const rows = renderDiffBlock(PAIR, look(overridden('markdown.diff.addedEmphasis', { hidden: true })))
    expect(rows[1]).not.toContain('48;2;')
    expect(rows[1]).toContain(added)
    expect(stripTerminalSequences(rows[1] ?? '')).toBe('+const textWidth = visibleWidth(drawn)')
  })

  it('draws a hidden row plain rather than dropping its text', () => {
    const rows = renderDiffBlock('-const a = 1', look(overridden('markdown.diff.removed', { hidden: true })))
    expect(rows[0]).toBe('-const a = 1')
  })
})
