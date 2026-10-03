import { describe, expect, it, vi } from 'vitest'
import { Marked } from '@earendil-works/pi-tui'
import { render } from 'lovely-mermaid'
import { createTheme } from '@/theme.ts'
import { DEFAULT_PALETTE } from '@/theme-defaults.ts'
import { createMermaidTransform, MERMAID_CACHE_LIMIT, MERMAID_MAX_SOURCE, type MermaidTransform } from '@/ui/mermaid.ts'
import type { MermaidMode } from '@/theme-settings.ts'

// Laying a source out once is the half a cache exists for, so a spec has to be able
// to count the layouts; the wrapper answers exactly as the library does.
vi.mock('lovely-mermaid', async (importOriginal) => {
  const actual = await importOriginal<typeof import('lovely-mermaid')>()
  return { ...actual, render: vi.fn(actual.render) }
})

/** The renderer is handed text the view already escaped, so fixtures carry no controls. */
const SIMPLE = ['```mermaid', 'flowchart LR', '  A[Start] --> B[Done]', '```'].join('\n')
const STREAMING_WIDTH = 80
const STREAMING_DELTAS = 3
const OVERFLOW_REPLY = Array.from({ length: MERMAID_CACHE_LIMIT + 1 }, (_, index) =>
  ['```mermaid', 'flowchart TB', `  N${index} --> M${index}`, '```'].join('\n'),
).join('\n\n')

const GROWING_REPLY_PREFIX = OVERFLOW_REPLY.split('\n\n').slice(0, MERMAID_CACHE_LIMIT - 1).join('\n\n')
const GROWING_FENCE = '\n\n```mermaid\nflowchart TB\n  Growing'

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
  it('retains completed layouts while the final fence gains streaming edges', () => {
    const draw = transform()
    const before = vi.mocked(render).mock.calls.length
    let reply = GROWING_REPLY_PREFIX + GROWING_FENCE
    for (let delta = 0; delta < STREAMING_DELTAS; delta++) {
      reply += ` --> Live${delta}`
      expect(draw(reply, STREAMING_WIDTH, true)).not.toContain('```mermaid')
    }
    expect(vi.mocked(render).mock.calls.length - before).toBe(MERMAID_CACHE_LIMIT - 1 + STREAMING_DELTAS)
  })

  it('keeps overflowing replies within retained layout capacity during streaming', () => {
    const draw = transform()
    const before = vi.mocked(render).mock.calls.length
    const initial = draw(OVERFLOW_REPLY, STREAMING_WIDTH, true)
    expect(vi.mocked(render).mock.calls.length - before).toBe(MERMAID_CACHE_LIMIT)
    expect(initial).toContain('```mermaid')
    const retained = vi.mocked(render).mock.calls.length
    for (let delta = 0; delta < STREAMING_DELTAS; delta += 1) {
      const tail = `\n\nstreaming ${delta}`
      expect(draw(OVERFLOW_REPLY + tail, STREAMING_WIDTH, true)).toBe(initial + tail)
    }
    expect(vi.mocked(render).mock.calls.length).toBe(retained)
  })

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
    // A streaming reply asks for the same fence on every delta, so the cache is what
    // keeps the layout cost off the repaint; it must release the sources a long reply
    // has gone past rather than hold every one it has ever drawn.
    const draw = transform()
    const source = (index: number): string => ['```mermaid', 'flowchart LR', `  N${index} --> M${index}`, '```'].join('\n')
    for (let index = 0; index <= MERMAID_CACHE_LIMIT; index += 1) draw(source(index), 80, false)
    const layouts = vi.mocked(render).mock.calls.length
    // Both ends of the window: the oldest has been let go, the newest is still held.
    draw(source(0), 80, false)
    expect(vi.mocked(render).mock.calls.length).toBe(layouts + 1)
    draw(source(MERMAID_CACHE_LIMIT), 80, false)
    expect(vi.mocked(render).mock.calls.length).toBe(layouts + 1)
  })
})
