import { describe, expect, it } from 'vitest'
import { createTheme } from '@/theme.ts'
import { DEFAULT_PALETTE } from '@/theme-tokens.ts'
import { createMermaidTransform, MERMAID_CACHE_LIMIT, type MermaidTransform } from '@/ui/mermaid.ts'
import type { MermaidMode } from '@/theme-settings.ts'

/** The renderer is handed text the view already escaped, so fixtures carry no controls. */
const SIMPLE = ['```mermaid', 'flowchart LR', '  A[Start] --> B[Done]', '```'].join('\n')

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
  })

  it('leaves fences that are not a top-level mermaid block alone', () => {
    const other = '```typescript\nconst a = 1\n```'
    const quoted = ['````', SIMPLE, '````'].join('\n')
    const inline = 'write `mermaid` in a fence'
    expect(transform()(other, 80, false)).toBe(other)
    expect(transform()(quoted, 80, false)).toBe(quoted)
    expect(transform()(inline, 80, false)).toBe(inline)
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
