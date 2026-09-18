import { describe, expect, it } from 'vitest'
import { Marked } from '@earendil-works/pi-tui'
import { createTheme } from '@/theme.ts'
import { DEFAULT_PALETTE } from '@/theme-tokens.ts'
import { createMermaidTransform, MERMAID_CACHE_LIMIT, MERMAID_MAX_SOURCE, type MermaidTransform } from '@/ui/mermaid.ts'
import type { MermaidMode } from '@/theme-settings.ts'

/** The renderer is handed text the view already escaped, so fixtures carry no controls. */
const SIMPLE = ['```mermaid', 'flowchart LR', '  A[Start] --> B[Done]', '```'].join('\n')

/** The token types a message lexes to, so a drawing cannot silently change the structure around it. */
function lex(markdown: string): string[] {
  return new Marked().lexer(markdown).map(token => token.type)
}

function transform(mode: MermaidMode = 'streaming', theme = createTheme('none')): MermaidTransform {
  return createMermaidTransform({ theme, mode: () => mode })
}

describe('a mermaid fence', () => {
  it('becomes a diagram, and the prose around it survives', () => {
    const rendered = transform()(`Before\n\n${SIMPLE}\n\nAfter`, 80, false)
    expect(rendered).toContain('Before')
    expect(rendered).toContain('After')
    expect(rendered).not.toContain('```mermaid')
    // A row is an inline code span, which is what keeps the art's spacing intact.
    expect(rendered).toContain('`│ Start ├───▶│ Done │`')
  })

  it('stays source when the renderer draws nothing', () => {
    const unsupported = '```mermaid\ngantt\n  title Pets\n```'
    expect(transform()(unsupported, 80, false)).toBe(unsupported)
  })

  it('stays source when the drawing is wider than the room it has', () => {
    expect(transform()(SIMPLE, 10, false)).toBe(SIMPLE)
    expect(transform()(SIMPLE, 21, false)).not.toContain('```mermaid')
    // Exactly the room it needs is room enough.
    expect(transform()(SIMPLE, 20, false)).toBe(SIMPLE)
  })

  it('stays source when the rows measure wider than the renderer thinks', () => {
    // A halfwidth kana plus a combining mark is one column to the renderer and
    // two to the terminal, so the rows, not the reported width, decide.
    const kana = '```mermaid\nflowchart TB\n  A[ｶﾞ] --> B[x]\n```'
    expect(transform()(kana, 6, false)).toBe(kana)
    expect(transform()(kana, 7, false)).not.toContain('```mermaid')
  })

  it('leaves fences that are not a top-level mermaid block alone', () => {
    const other = '```typescript\nconst a = 1\n```'
    const quoted = ['````', SIMPLE, '````'].join('\n')
    const inline = 'write `mermaid` in a fence'
    expect(transform()(other, 80, false)).toBe(other)
    expect(transform()(quoted, 80, false)).toBe(quoted)
    expect(transform()(inline, 80, false)).toBe(inline)
  })

  it('leaves a message that only mentions mermaid exactly as written', () => {
    // Rebuilding a message from lexed tokens would drop what the lexer drops.
    const prose = 'Prose about mermaid.\n\n[ref]: /first\n[ref]: /second\n\nSee [ref].\n'
    expect(transform()(prose, 80, false)).toBe(prose)
  })

  it('keeps a reference definition the lexer did not tokenize', () => {
    const src = `[ref]: /first\n[ref]: /second\n\n${SIMPLE}\n\nSee [ref].\n`
    const rendered = transform()(src, 80, false)
    expect(rendered).toContain('[ref]: /second')
    expect(rendered).not.toContain('```mermaid')
  })

  it('keeps the rule that follows it on the next line a rule', () => {
    const rendered = transform()(`${SIMPLE}\n---\n`, 80, false)
    expect(lex(rendered)).toContain('hr')
    expect(rendered).toContain('\n\n---')
  })

  it('reads tilde fences, trailing info words, and any case', () => {
    const tilde = '~~~mermaid\nflowchart LR\n  A --> B\n~~~'
    const titled = '```MERMAID title="path"\nflowchart LR\n  A --> B\n```'
    expect(transform()(tilde, 80, false)).toContain('┌───┐')
    expect(transform()(titled, 80, false)).toContain('┌───┐')
  })

  it('draws a half-typed diagram while the reply is still streaming', () => {
    const partial = '```mermaid\nflowchart LR\n  A --> B'
    expect(transform()(partial, 80, true)).toContain('┌───┐')
  })

  it('shows the source and the reason once a lossy drawing settles', () => {
    const lossy = '```mermaid\nflowchart LR\n  A[Foo] invalid\n```'
    const settled = transform()(lossy, 80, false)
    expect(settled).toContain('```mermaid')
    expect(settled).toContain('Mermaid diagram not rendered: dropped, expected a link: "invalid"')
    // A partial drawing is still shown mid-stream, where warnings mean the reader is watching it being typed.
    expect(transform()(lossy, 80, true)).not.toContain('Mermaid diagram not rendered')
    expect(transform()(lossy, 80, true)).toContain('│ Foo │')
  })

  it('names one warning and counts the rest', () => {
    const lossy = '```mermaid\nflowchart LR\n  A[Foo] invalid\n  B[Bar] also-invalid\n```'
    const settled = transform()(lossy, 80, false)
    expect(settled).toContain('dropped, expected a link: "invalid"')
    expect(settled).toContain('(+1 more)')
    expect(settled).not.toContain('dropped, expected a link: "also-invalid"')
  })

  it('names what it dropped even when the drawing cannot fit', () => {
    const many = Array.from({ length: 200 }, (_, index) => `  n${index} --> n${index + 1}`).join('\n')
    const truncated = ['```mermaid', 'flowchart TB', many, '```'].join('\n')
    const settled = transform()(truncated, 4, false)
    expect(settled).toContain('```mermaid')
    expect(settled).toContain('Mermaid diagram not rendered:')
  })

  it('settles a fence with more backtick runs than a call stack holds arguments', () => {
    const runs = 16000
    const junk = '`a'.repeat(runs)
    const src = ['```mermaid', 'flowchart TB', '  A --> B', `  ${junk}`, '```'].join('\n')
    expect(src.length).toBeLessThan(MERMAID_MAX_SOURCE)
    expect(() => transform()(src, 120, false)).not.toThrow()
    expect(transform()(src, 120, false)).toContain('Mermaid diagram not rendered:')
  })

  it('stays source when a fence is larger than a frame lays out', () => {
    const filler = 'x'.repeat(MERMAID_MAX_SOURCE)
    const huge = ['```mermaid', 'flowchart TB', '  A --> B', `  %% ${filler}`, '```'].join('\n')
    expect(transform()(huge, 200, false)).toBe(huge)
  })

  it('draws a row that carries a backtick', () => {
    const src = '```mermaid\nflowchart TB\n  A["a `tick` here"] --> B[x]\n```'
    expect(transform()(src, 120, false)).toContain('`` │ a `tick` here │``')
  })

  it('keeps a blank row standing on a non-breaking space', () => {
    const src = '```mermaid\n---\ntitle: A title\n---\nflowchart TB\n  A --> B\n```'
    expect(transform()(src, 120, false)).toContain('\u00a0')
  })
})

describe('the mermaid mode', () => {
  it('draws nothing at all when the reader turned it off', () => {
    expect(transform('off')(SIMPLE, 80, false)).toBe(SIMPLE)
    expect(transform('off')(SIMPLE, 80, true)).toBe(SIMPLE)
  })

  it('waits for the settled reply in final mode', () => {
    expect(transform('final')(SIMPLE, 80, true)).toBe(SIMPLE)
    expect(transform('final')(SIMPLE, 80, false)).not.toContain('```mermaid')
  })
})

describe('a drawn diagram', () => {
  it('adds no escape of its own when colour is off', () => {
    expect(transform()(SIMPLE, 80, false)).not.toContain('\u001b')
  })

  it('styles the art through the diagram tokens', () => {
    const theme = createTheme('truecolor', {
      palette: DEFAULT_PALETTE,
      tokens: new Map([
        ['markdown.diagram.border', { fg: '#00ff00' }],
        ['markdown.diagram.edge', { fg: '#ff0000' }],
      ]),
    })
    const rendered = transform('streaming', theme)(SIMPLE, 80, false)
    expect(rendered).toContain('38;2;0;255;0')
    expect(rendered).toContain('38;2;255;0;0')
  })

  it('still draws once more diagrams than the cache holds have gone by', () => {
    const draw = transform()
    for (let index = 0; index <= MERMAID_CACHE_LIMIT; index += 1) {
      draw(['```mermaid', 'flowchart LR', `  N${index} --> M${index}`, '```'].join('\n'), 80, false)
    }
    expect(draw(SIMPLE, 80, false)).toContain('│ Start ├───▶│ Done │')
  })
})
