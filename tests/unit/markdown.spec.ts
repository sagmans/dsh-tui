import { describe, expect, it } from 'vitest'
import { createTheme, forwardMarkdownTheme } from '@/theme.ts'
import { DEFAULT_PALETTE } from '@/theme-tokens.ts'
import { MARKDOWN_CACHE_LIMIT, MarkdownRenderer } from '@/ui/markdown.ts'

const theme = createTheme('none')
const renderer = (): MarkdownRenderer => new MarkdownRenderer(theme.markdown)

describe('MarkdownRenderer', () => {
  it('renders the structure a reader scans for', () => {
    const lines = renderer().render('# Heading\n\n- one\n- two\n\n`code`', 60)
    expect(lines.join('\n')).toContain('Heading')
    expect(lines.join('\n')).toContain('- one')
    expect(lines.join('\n')).toContain('code')
  })

  it('never asks for less than one column', () => {
    expect(() => renderer().render('text', 0)).not.toThrow()
    expect(renderer().render('text', -5).length).toBeGreaterThan(0)
  })

  it('re-renders a message when the width changes', () => {
    const markdown = renderer()
    const wide = markdown.render('one two three four five six seven eight nine ten', 80)
    const narrow = markdown.render('one two three four five six seven eight nine ten', 20)
    expect(narrow.length).toBeGreaterThan(wide.length)
  })

  it('keeps a bounded number of parsed messages', () => {
    const markdown = renderer()
    for (let index = 0; index <= MARKDOWN_CACHE_LIMIT; index += 1) markdown.render(`message ${index}`, 40)
    // The oldest was evicted, so rendering it again still produces rows.
    expect(markdown.render('message 0', 40).join('')).toContain('message 0')
  })

  it('re-renders a message from the moved theme after invalidate', () => {
    // A Markdown caches the lines it drew for a width, so the renderer has to
    // drop them or a settings change would never reach the answer.
    let active = createTheme('truecolor', { palette: DEFAULT_PALETTE, tokens: new Map([['markdown.heading', { fg: '#ff0000' }]]) })
    const markdown = new MarkdownRenderer(forwardMarkdownTheme(() => active.markdown))
    expect(markdown.render('# hi', 40).join('\n')).toContain('38;2;255;0;0')
    active = createTheme('truecolor', { palette: DEFAULT_PALETTE, tokens: new Map([['markdown.heading', { fg: '#00ff00' }]]) })
    markdown.invalidate()
    expect(markdown.render('# hi', 40).join('\n')).toContain('38;2;0;255;0')
  })
})
