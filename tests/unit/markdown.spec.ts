import { describe, expect, it } from 'vitest'
import { createTheme, forwardMarkdownTheme } from '@/theme.ts'
import { DEFAULT_PALETTE, DIFF_ADDED_BAND, DIFF_REMOVED_BAND } from '@/theme-defaults.ts'
import { MARKDOWN_CACHE_LIMIT, MarkdownRenderer } from '@/ui/markdown.ts'
import { createMermaidTransform } from '@/ui/mermaid.ts'

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

  it('keeps the live and the settled rendering of one message apart', () => {
    // A streaming reply can settle on the same text, and the two renderings
    // differ: only the settled one is allowed to report what the drawing lost.
    const calls: Array<{ readonly live: boolean }> = []
    const markdown = new MarkdownRenderer(theme.markdown, (_text, _width, live) => {
      calls.push({ live })
      return live ? 'live view' : 'settled view'
    })
    expect(markdown.render('a mermaid reply', 60, true).join('\n')).toContain('live view')
    expect(markdown.render('a mermaid reply', 60, false).join('\n')).toContain('settled view')
    expect(calls).toEqual([{ live: true }, { live: false }])
  })

  it('hands the transform the width the message has', () => {
    const widths: number[] = []
    const markdown = new MarkdownRenderer(theme.markdown, (_text, width) => {
      widths.push(width)
      return 'drawing'
    })
    markdown.render('a mermaid reply', 64, false)
    expect(widths).toEqual([64])
  })

  it('does not call the transform again while the message and width hold', () => {
    let renders = 0
    const markdown = new MarkdownRenderer(theme.markdown, () => {
      renders += 1
      return 'drawing'
    })
    markdown.render('a mermaid reply', 60, true)
    markdown.render('a mermaid reply', 60, true)
    expect(renders).toBe(1)
  })

  it('drops both renderings when invalidate is called', () => {
    let renders = 0
    const markdown = new MarkdownRenderer(theme.markdown, () => {
      renders += 1
      return 'drawing'
    })
    markdown.render('a mermaid reply', 60, true)
    markdown.render('a mermaid reply', 60, false)
    markdown.invalidate()
    markdown.render('a mermaid reply', 60, true)
    markdown.render('a mermaid reply', 60, false)
    expect(renders).toBe(4)
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

describe('a fenced diff', () => {
  /** A colour as an escape carries it, so an assertion names the palette entry it came from. */
  const rgb = (hex: string): string => [1, 3, 5].map(at => Number.parseInt(hex.slice(at, at + 2), 16)).join(';')

  const render = (active: ReturnType<typeof createTheme>, text: string): string =>
    new MarkdownRenderer(active.markdown).render(text, 60).join('\n')

  it('draws its rows in the diff elements', () => {
    const rows = render(createTheme('truecolor'), ['```diff', '@@ -1 +1 @@', '-const a = 1', '+const a = 2', '```'].join('\n'))
    expect(rows).toContain(`38;2;${rgb(DEFAULT_PALETTE.removed)}`)
    expect(rows).toContain(`38;2;${rgb(DEFAULT_PALETTE.added)}`)
    // The characters that changed sit on a band, which is what tells an edit from a replacement.
    expect(rows).toContain(`48;2;${rgb(DIFF_REMOVED_BAND)}`)
    expect(rows).toContain(`48;2;${rgb(DIFF_ADDED_BAND)}`)
  })

  it('leaves a fence of another language exactly as the library drew it', () => {
    // The highlighter answers for every fence the library draws, so this equality
    // is the regression the plain path exists for.
    const active = createTheme('truecolor')
    const code = 'const dock = new WorkDock(state, theme)'
    const rows = new MarkdownRenderer(active.markdown).render(['```ts', code, '```'].join('\n'), 60).map(row => row.trimEnd())
    expect(rows).toEqual([
      active.markdown.codeBlockBorder('```ts'),
      `  ${active.markdown.codeBlock(code)}`,
      active.markdown.codeBlockBorder('```'),
    ])
  })

  it('recolours a diff when the table moves', () => {
    // A Markdown caches the rows it drew, so a settings change has to reach the
    // fence through the forwarded highlighter as well as the invalidate.
    const fence = ['```diff', '+const a = 1', '```'].join('\n')
    let active = createTheme('truecolor', { palette: DEFAULT_PALETTE, tokens: new Map([['markdown.diff.added', { fg: '#ff0000' }]]) })
    const markdown = new MarkdownRenderer(forwardMarkdownTheme(() => active.markdown))
    expect(markdown.render(fence, 60).join('\n')).toContain('38;2;255;0;0')
    active = createTheme('truecolor', { palette: DEFAULT_PALETTE, tokens: new Map([['markdown.diff.added', { fg: '#00ff00' }]]) })
    markdown.invalidate()
    expect(markdown.render(fence, 60).join('\n')).toContain('38;2;0;255;0')
  })

  it('draws a diff beside a diagram in the same message', () => {
    // Two seams on one message: the transform rewrites the fence it owns and the
    // highlighter draws the one it owns, neither consuming the other's block.
    const active = createTheme('truecolor')
    const text = [
      '```mermaid', 'flowchart LR', '  A --> B', '```', '',
      '```diff', '-const a = 1', '+const a = 2', '```',
    ].join('\n')
    const markdown = new MarkdownRenderer(active.markdown, createMermaidTransform({ theme: active, mode: () => 'streaming' }))
    const rows = markdown.render(text, 80).join('\n')
    expect(rows).toContain('┌───┐')
    expect(rows).toContain(`48;2;${rgb(DIFF_ADDED_BAND)}`)
  })
})

describe('MarkdownFace', () => {
  it('bases text the markdown does not rule on in the shade the row carries', () => {
    const lines = renderer().render('plain words', 40, false, { name: 'prompt', base: { color: text => `[${text}]` } })
    expect(lines.join('\n')).toContain('[plain words]')
  })

  it('parses one text once per face instead of sharing a cached parse', () => {
    let renders = 0
    const markdown = new MarkdownRenderer(theme.markdown, () => {
      renders += 1
      return 'drawing'
    })
    const thought = { name: 'thought', transform: false } as const
    expect(markdown.render('a mermaid reply', 60, false).join('\n')).toContain('drawing')
    expect(markdown.render('a mermaid reply', 60, false, thought).join('\n')).toContain('a mermaid reply')
    // Asking for the answer again must still draw: if the thought had taken the
    // answer's cache entry, this call would hand back the thought's own rows.
    expect(markdown.render('a mermaid reply', 60, false).join('\n')).toContain('drawing')
    // One transform for the one face that asks for it: the thought's parse is
    // its own, and reinstalls nothing on the answer's.
    expect(renders).toBe(1)
  })

  it('leaves a face without the transform alone even when the renderer has one', () => {
    let renders = 0
    const markdown = new MarkdownRenderer(theme.markdown, () => {
      renders += 1
      return 'drawing'
    })
    const lines = markdown.render('a mermaid reply', 60, false, { name: 'thought', transform: false })
    expect(renders).toBe(0)
    expect(lines.join('\n')).toContain('a mermaid reply')
  })
})
