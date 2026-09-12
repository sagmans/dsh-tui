import { describe, expect, it } from 'vitest'
import { createTheme } from '@/theme.ts'
import type { ThemeOverrides } from '@/theme-settings.ts'
import { DEFAULT_PALETTE, type StyleSpec, type TuiToken } from '@/theme-tokens.ts'

const overrides = (tokens: Partial<Record<TuiToken, StyleSpec>>, palette = DEFAULT_PALETTE): ThemeOverrides => ({
  palette,
  tokens: new Map(Object.entries(tokens) as [TuiToken, StyleSpec][]),
})

describe('createTheme', () => {
  it('styles nothing when colour is off', () => {
    const theme = createTheme('none')
    expect(theme.style('transcript.user', 'x')).toBe('x')
    expect(theme.markdown.heading('x')).toBe('x')
    expect(theme.editor.borderColor('x')).toBe('x')
    expect(theme.color).toBe(false)
  })

  it('paints muted elements an explicit grey, not a palette slot', () => {
    const theme = createTheme('truecolor')
    expect(theme.style('transcript.reasoning.body', 'x')).toBe('\u001B[38;2;138;138;138mx\u001B[0m')
    expect(theme.style('transcript.reasoning.summary', 'x')).toContain('38;2;')
    expect(theme.style('tool.detail', 'x')).toContain('38;2;')
  })

  it('leaves the answer text alone while the thinking is styled', () => {
    const theme = createTheme('truecolor')
    expect(theme.style('markdown.text', 'the answer')).toBe('the answer')
    expect(theme.style('transcript.reasoning.body', 'a thought')).not.toBe('a thought')
  })

  it('honours an override', () => {
    const theme = createTheme('truecolor', overrides({ 'transcript.user': { fg: '#ff0000', bold: true } }))
    expect(theme.style('transcript.user', 'x')).toBe('\u001B[1;38;2;255;0;0mx\u001B[0m')
  })

  it('honours a palette override through the elements that name it', () => {
    const theme = createTheme('truecolor', overrides({}, { ...DEFAULT_PALETTE, muted: '#123456' }))
    expect(theme.style('transcript.notice', 'x')).toContain('38;2;18;52;86')
  })

  it('hides an element the reader turned off, and its glyph with it', () => {
    const theme = createTheme('truecolor', overrides({ 'status.cwd': { hidden: true, glyph: '#' } }))
    expect(theme.visible('status.cwd')).toBe(false)
    expect(theme.glyph('status.cwd')).toBe('')
  })

  it('ships no glyphs, so an element is its text', () => {
    const theme = createTheme('truecolor')
    expect(theme.glyph('transcript.reasoning.summary')).toBe('')
    expect(theme.visible('transcript.reasoning.summary')).toBe(true)
  })

  it('returns a reader-set glyph', () => {
    const theme = createTheme('truecolor', overrides({ 'transcript.reasoning.summary': { glyph: '~' } }))
    expect(theme.glyph('transcript.reasoning.summary')).toBe('~')
  })

  it('degrades to the terminal budget instead of dropping the shade', () => {
    const truecolor = createTheme('truecolor').style('transcript.reasoning.body', 'x')
    const sixteen = createTheme('16').style('transcript.reasoning.body', 'x')
    const twofifty = createTheme('256').style('transcript.reasoning.body', 'x')
    expect(truecolor).toContain('38;2;')
    expect(twofifty).toContain('38;5;')
    expect(sixteen).not.toContain('38;')
    expect(sixteen).not.toBe('x')
  })

  it('derives the pi-tui themes from the same table', () => {
    const theme = createTheme('truecolor')
    expect(theme.markdown.heading('h')).toContain('\u001B[')
    expect(theme.editor.selectList.selectedText('s')).toContain('\u001B[1m')
    expect(theme.editor.selectList.description('d')).toContain('38;2;')
  })

  it('resolves a token once per theme rather than per call', () => {
    // A repaint walks every row, so the palette chain must not be re-walked.
    const theme = createTheme('truecolor')
    const first = theme.style('transcript.reasoning.body', 'a')
    const second = theme.style('transcript.reasoning.body', 'b')
    expect(first.replace('a', 'b')).toBe(second)
  })
})
