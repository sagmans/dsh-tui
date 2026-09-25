/**
 * How messages draw: a submitted prompt, a reply, a recorded thought folded or
 * open, and the notices and markers the transcript keeps between them.
 */

import { describe, expect, it } from 'vitest'
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { cardOfCall, cardOfResult } from '@/cards/presenter.ts'
import { contentLines, type ToolPresenter } from '@/cards.ts'
import { createTheme } from '@/theme.ts'
import { DEFAULT_PALETTE, DIFF_ADDED_BAND } from '@/theme-defaults.ts'
import { TranscriptModel } from '@/transcript.ts'
import { MarkdownRenderer } from '@/ui/markdown.ts'
import { TranscriptView } from '@/ui/view.ts'
import { theme, COLLAPSED, viewOf, mouse } from './fixtures/transcript-view.ts'

describe('TranscriptView text', () => {
  it('renders assistant text as markdown inside its frame', () => {
      const model = new TranscriptModel()
      model.apply({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '# Title\n\nplain **strong**' }] } } })
      const lines = viewOf(model).render(60)
      expect(lines[0]?.startsWith('╭')).toBe(true)
      expect(lines.at(-1)?.startsWith('╰')).toBe(true)
      const body = stripTerminalSequences(lines.join('\n'))
      expect(body).toContain('Title')
      expect(body).toContain('strong')
      expect(body).not.toContain('**')
    })
  it("renders a submitted prompt's markdown inside its frame", () => {
      const model = new TranscriptModel()
      model.apply({
        type: 'user/message',
        data: { content: [{ type: 'text', text: '**bold** steps:\n\n- one\n- two' }], source: { kind: 'user' } },
      })
      const lines = viewOf(model).render(40)
      expect(lines[0]?.startsWith('╭')).toBe(true)
      expect(lines.at(-1)?.startsWith('╰')).toBe(true)
      const body = stripTerminalSequences(lines.join('\n'))
      expect(body).toContain('bold steps:')
      expect(body).not.toContain('**')
      expect(body).toContain('- one')
      expect(body).toContain('- two')
    })
  it("closes a human prompt into the editor's own frame", () => {
      const model = new TranscriptModel()
      model.apply({ type: 'user/message', data: { content: [{ type: 'text', text: 'hello there' }], source: { kind: 'user' } } })
      // The box the editor and the queued prompts draw, so a submitted prompt reads
      // as the object it was typed into rather than as one more paragraph.
      expect(viewOf(model).render(40)).toEqual([
        `╭${'─'.repeat(38)}╮`,
        `│ hello there${' '.repeat(25)} │`,
        `╰${'─'.repeat(38)}╯`,
      ])
    })
  it('closes a reply into a frame of its own', () => {
      const model = new TranscriptModel()
      model.apply({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'hello there' }] } } })
      // A reply is the other object of an exchange, so it is framed like the prompt
      // that asked for it rather than left as one more paragraph of the transcript.
      expect(viewOf(model).render(40)).toEqual([
        `╭${'─'.repeat(38)}╮`,
        `│ hello there${' '.repeat(25)} │`,
        `╰${'─'.repeat(38)}╯`,
      ])
    })
  it('leaves a surface notice outside the frame', () => {
      const model = new TranscriptModel()
      model.notice('compacted 12 events')
      expect(viewOf(model).render(40)).toEqual(['compacted 12 events'])
    })
  it('renders a recorded thought, folded or open, dimmed, and frames the answer', () => {
      const model = new TranscriptModel()
      model.apply({
        type: 'assistant/message',
        data: {
          message: {
            content: [
              { type: 'reasoning', text: 'first thought\nsecond thought' },
              { type: 'text', text: 'the answer' },
            ],
          },
        },
      })
      const colour = createTheme('truecolor')
      const markdown = new MarkdownRenderer(colour.markdown)
      const folded = new TranscriptView(model, colour, markdown, { state: () => ({ expandCards: false, expandReasoning: false, expandSubCalls: false }) }).render(60)
      expect(folded).toEqual(expect.arrayContaining([expect.stringContaining('reasoning · 7 tokens')]))
      // The signpost is its own faint shade, italic, not the muted grey the body
      // takes: the row names the thought, it is not the thought.
      expect(folded[0]).toContain('\u001b[3;38;2;102;102;102m')
      expect(folded[0]).not.toContain('\u001b[38;2;138;138;138m')
      expect(folded.some(line => line.includes('second thought'))).toBe(false)
  
      const opened = new TranscriptView(model, colour, markdown, { state: () => ({ expandCards: false, expandReasoning: true, expandSubCalls: false }) }).render(60)
      // The signpost, the two thought rows, and the framed answer: a reply is an
      // object of its own rather than one more row under the thought.
      expect(opened).toHaveLength(6)
      expect(opened[0]).toContain('\u001b[3;38;2;102;102;102m')
      // The thought shares the signpost's faint shade, not the muted family's.
      for (const line of opened.slice(1, 3)) expect(line).toContain('\u001b[38;2;102;102;102m')
      // The frame's own rows carry the border's shade, so the corners are found in
      // the row rather than at its start.
      expect(opened[3]).toContain('╭')
      expect(stripTerminalSequences(opened[4] ?? '')).toContain('the answer')
      expect(opened[5]).toContain('╰')
    })
  it('renders an opened thought as markdown in the thought shade', () => {
      const colour = createTheme('truecolor')
      const model = new TranscriptModel()
      model.apply({
        type: 'assistant/message',
        data: { message: { content: [{ type: 'reasoning', text: '**bold** plan\n\n- one' }, { type: 'text', text: 'the answer' }] } },
      })
      const opened = new TranscriptView(model, colour, new MarkdownRenderer(colour.markdown), {
        state: () => ({ expandCards: false, expandReasoning: true, expandSubCalls: false }),
      }).render(60)
      const body = stripTerminalSequences(opened.join('\n'))
      expect(body).toContain('bold plan')
      expect(body).not.toContain('**')
      expect(body).toContain('- one')
      // The structure is markdown's, the shade is still the thought's: the
      // answer's accent must not leak into a row meant to stay recessive. A blank
      // row holds no text and so has no shade to check, and the signpost row above
      // the body carries its own fainter one.
      expect(opened[0]).toContain('\u001b[3;38;2;102;102;102m')
      // The thought body ends where the answer's frame begins, and that frame is
      // gold rather than faint: the loop stops at the box so the reply's own border
      // is not read as a thought row that lost its shade.
      const framed = opened.findIndex(line => line.includes('╭'))
      expect(framed).toBeGreaterThan(0)
      for (const line of opened.slice(1, framed).filter(line => line !== '')) {
        expect(line).toContain('\u001b[38;2;102;102;102m')
      }
      expect(stripTerminalSequences(opened.slice(framed).join('\n'))).toContain('the answer')
    })
  it('keeps a thought fence as source while the answer still draws it', () => {
      const fence = '**note**\n\n```mermaid\nflowchart TB\n  A --> B\n```'
      let rendered = 0
      const markdown = new MarkdownRenderer(theme.markdown, () => {
        rendered += 1
        return 'DIAGRAM'
      })
      const model = new TranscriptModel()
      model.apply({
        type: 'assistant/message',
        data: { message: { content: [{ type: 'reasoning', text: fence }, { type: 'text', text: fence }] } },
      })
      const lines = new TranscriptView(model, theme, markdown, {
        state: () => ({ expandCards: false, expandReasoning: true, expandSubCalls: false }),
      }).render(60)
      const drawn = lines.join('\n')
      // One drawing for the answer, none for the thought: a thought parses its own
      // markdown but a diagram would give the thinking the answer's weight.
      expect(rendered).toBe(1)
      expect(drawn).toContain('DIAGRAM')
      expect(drawn).toContain('```mermaid')
      expect(stripTerminalSequences(drawn)).not.toContain('**')
    })
  it('wraps a long line to the width it was given', () => {
      const model = new TranscriptModel()
      model.apply({ type: 'user/message', data: { content: [{ type: 'text', text: 'x'.repeat(50) }], source: { kind: 'user' } } })
      const lines = viewOf(model).render(20)
      expect(lines.length).toBeGreaterThan(1)
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(20)
    })
  it('wraps a long prompt inside its frame instead of cutting it', () => {
      const model = new TranscriptModel()
      model.apply({ type: 'user/message', data: { content: [{ type: 'text', text: 'x'.repeat(50) }], source: { kind: 'user' } } })
      const lines = viewOf(model).render(40)
      expect(lines).toHaveLength(4)
      for (const line of lines) expect(visibleWidth(line)).toBe(40)
      expect(lines[0]?.startsWith('╭')).toBe(true)
      expect(lines[3]?.startsWith('╰')).toBe(true)
      // Every column of the prompt survives the fold: the frame costs the text
      // width, it never costs the reader a line.
      const body = lines.slice(1, 3).map(line => line.slice(2, -2).trimEnd()).join('')
      expect(body).toBe('x'.repeat(50))
    })
})

describe('TranscriptView markers', () => {
  it('sets a boundary row apart from what anyone said', () => {
      const model = new TranscriptModel()
      model.marker('compacted 12 events (≈3000 tokens)')
      expect(viewOf(model).render(60)).toEqual(['compacted 12 events (≈3000 tokens)'])
    })
})

describe('TranscriptView expansion', () => {
  /** A tool card of `rows` lines, from a tool that presents shell output only when asked. */
    const withRows = (rows: number, name = 'read'): TranscriptModel => {
      const lines = Array.from({ length: rows }, (_, index) => `row ${index}`)
      const presenter: ToolPresenter = {
        call: (toolName, argumentsJson) => cardOfCall(
          toolName === 'bash'
            ? { card: 'terminal', title: 'Run echo rows' }
            : { card: 'generic', title: `Read ${argumentsJson}` },
          toolName,
        ),
        result: (toolName, input) => cardOfResult(
          toolName === 'bash'
            ? { card: 'terminal', title: 'Run echo rows', output: contentLines(input.content).join('\n'), exitCode: 0 }
            : { card: 'generic', title: `Read ${name}` },
          { name: toolName, failed: input.isError, contentLines: contentLines(input.content) },
        ),
      }
      const model = new TranscriptModel(presenter)
      model.apply({ type: 'tool/call', data: { name, arguments: '{"path":"a.ts"}', callId: 'c1' } })
      model.apply({
        type: 'tool/result',
        data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', text: lines.join('\n') }], isError: false } },
      })
      return model
    }
  it('opens one clicked thought and leaves the other folded', () => {
      const model = new TranscriptModel()
      model.apply({
        type: 'assistant/message',
        data: { message: { content: [
          { type: 'reasoning', text: 'first thought' },
          { type: 'reasoning', text: 'second thought' },
          { type: 'text', text: 'answer' },
        ] } },
      })
      const view = viewOf(model)
      const folded = view.render(60)
      expect(folded[0]).toMatch(/^reasoning · \d+ tokens \(shift\+tab\)$/)
      expect(folded[1]).toMatch(/^reasoning · \d+ tokens \(shift\+tab\)$/)
      // A click opens the thought it landed on; the one below stays folded.
      expect(view.handleMouse(mouse('click', 'left', 0))).toEqual({ handled: true, render: true })
      const opened = view.render(60)
      expect(opened[1]).toBe('    first thought')
      expect(opened.join('\n')).not.toContain('    second thought')
      expect(opened[2]).toMatch(/\(shift\+tab\)$/)
      // The choice survives the repaint, and a second click folds it back.
      expect(view.render(60)).toEqual(opened)
      view.handleMouse(mouse('click', 'left', 0))
      expect(view.render(60)).toEqual(folded)
    })
  it('opens a clicked thought while it is still streaming', () => {
      const model = new TranscriptModel()
      model.notice('before')
      model.applyStreamChunk({ type: 'reasoning-delta', text: 'live thought' })
      const view = viewOf(model)
      const rows = view.render(60)
      expect(rows[0]).toBe('before')
      expect(rows[1]).toMatch(/^reasoning · 3 tokens/)
      // The thought's rows begin after the notice, and the hit target has to move
      // with them: a span counted twice would sit past the thought's own row.
      expect(view.handleMouse(mouse('click', 'left', 1))).toEqual({ handled: true, render: true })
      expect(view.render(60)).toContain('    live thought')
    })
  it('keeps a folded reasoning row inside a terminal too narrow for its key', () => {
      const model = new TranscriptModel()
      model.apply({ type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'thought' }, { type: 'text', text: 'answer' }] } } })
      const rows = viewOf(model).render(5)
      // The key cannot fit beside the signpost, so the row gives up its tail rather
      // than the surface losing it past the edge where nothing can count it.
      expect(rows.every(row => visibleWidth(row) <= 5)).toBe(true)
    })
  it('names where the thought is when the row is folded', () => {
      let clock = 0
      const model = new TranscriptModel(undefined, () => clock)
      model.applyStreamChunk({ type: 'reasoning-delta', text: 'first thought\nsecond thought' })
      clock = 5_000
      model.applyStreamChunk({ type: 'block-end', block: { type: 'reasoning' } })
      const folded = viewOf(model).render(60)
      // The row must say the body exists: a count with no way to reach the text
      // reads the same as the text never having arrived. The key rides the row so
      // naming it costs no line.
      expect(folded).toEqual([
        'reasoning · 7 tokens · 5s (shift+tab)',
      ])
      const opened = viewOf(model, { expandCards: false, expandReasoning: true, expandSubCalls: false }).render(60)
      expect(opened).toEqual([
        'reasoning · 7 tokens · 5s',
        '    first thought',
        '    second thought',
      ])
    })
})

describe('TranscriptView theming', () => {
  const userModel = (): TranscriptModel => {
      const model = new TranscriptModel()
      model.apply({ type: 'user/message', data: { content: [{ type: 'text', text: 'hello there' }], source: { kind: 'user' } } })
      return model
    }
  it('dresses a prompt in its mint shade without the weight', () => {
      const colour = createTheme('truecolor')
      const lines = new TranscriptView(userModel(), colour, new MarkdownRenderer(colour.markdown), { state: () => COLLAPSED }).render(40)
      expect(lines.join('\n')).toContain('\u001b[38;2;39;245;200mhello there\u001b[0m')
      expect(lines.join('\n')).not.toContain('\u001b[1;')
    })
  it('draws a prompt bare when the frame is hidden', () => {
      const bare = createTheme('truecolor', { palette: DEFAULT_PALETTE, tokens: new Map([['editor.border', { hidden: true }]]) })
      const lines = new TranscriptView(userModel(), bare, new MarkdownRenderer(bare.markdown), { state: () => COLLAPSED }).render(40)
      expect(lines).toHaveLength(1)
      // No frame, but the text keeps the column the frame's own air gave it, so a
      // theme that hides the border does not move the prompt.
      expect(lines[0]?.trimEnd()).toBe(' \u001b[38;2;39;245;200mhello there\u001b[0m')
    })
  it("draws a reply's frame in the assistant border shade", () => {
      const model = new TranscriptModel()
      model.apply({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'the answer' }] } } })
      const colour = createTheme('truecolor')
      const lines = new TranscriptView(model, colour, new MarkdownRenderer(colour.markdown), { state: () => COLLAPSED }).render(40)
      // #d6c29a, the shade the shipped table gives the reply's own frame.
      expect(lines[0]).toContain('38;2;214;194;154')
      expect(lines.at(-1)).toContain('38;2;214;194;154')
    })
  it('draws a reply bare when its frame element is hidden', () => {
      const model = new TranscriptModel()
      model.apply({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'the answer' }] } } })
      const bare = createTheme('truecolor', { palette: DEFAULT_PALETTE, tokens: new Map([['transcript.assistant.border', { hidden: true }]]) })
      const lines = new TranscriptView(model, bare, new MarkdownRenderer(bare.markdown), { state: () => COLLAPSED }).render(40)
      expect(lines).toHaveLength(1)
      // No frame, but the text keeps the column the frame's own air gave it, so a
      // theme that hides the border does not move the reply.
      expect(lines[0]?.trimEnd()).toBe(' the answer')
    })
  it('draws nothing for a hidden element', () => {
      const hidden = createTheme('truecolor', { palette: DEFAULT_PALETTE, tokens: new Map([['transcript.user', { hidden: true }]]) })
      const lines = new TranscriptView(userModel(), hidden, new MarkdownRenderer(hidden.markdown), { state: () => COLLAPSED }).render(60)
      expect(lines.join('\n')).not.toContain('hello')
    })
  it('hides a reasoning body without hiding its summary', () => {
      const model = new TranscriptModel()
      model.apply({ type: 'assistant/message', data: {
        message: { content: [{ type: 'reasoning', text: 'secret thought' }, { type: 'text', text: 'the answer' }] },
      } })
      const hidden = createTheme('truecolor', { palette: DEFAULT_PALETTE, tokens: new Map([['transcript.reasoning.body', { hidden: true }]]) })
      const lines = new TranscriptView(model, hidden, new MarkdownRenderer(hidden.markdown), {
        state: () => ({ expandCards: false, expandReasoning: true, expandSubCalls: false }),
      }).render(60)
      expect(lines.join('\n')).not.toContain('secret thought')
      expect(lines.join('\n')).toContain('reasoning ·')
    })
  it('draws a diff inside a thought in the diff elements', () => {
      // A thought refuses the answer's drawings and shades, but a diff is the change
      // itself rather than decoration: a reader following a thought has to see which
      // side of it moved, while everything else the thought says stays recessive.
      const model = new TranscriptModel()
      model.apply({ type: 'assistant/message', data: {
        message: {
          content: [
            { type: 'reasoning', text: ['thinking about the change', '', '```diff', '-const a = 1', '+const a = 2', '```'].join('\n') },
            { type: 'text', text: 'the answer' },
          ],
        },
      } })
      const colour = createTheme('truecolor')
      const lines = new TranscriptView(model, colour, new MarkdownRenderer(colour.markdown), {
        state: () => ({ expandCards: false, expandReasoning: true, expandSubCalls: false }),
      }).render(60)
      const shown = lines.join('\n')
      const rgb = (hex: string) => [1, 3, 5].map(at => Number.parseInt(hex.slice(at, at + 2), 16)).join(';')
      expect(shown).toContain(`38;2;${rgb(DEFAULT_PALETTE.added)}`)
      expect(shown).toContain(`48;2;${rgb(DIFF_ADDED_BAND)}`)
      expect(shown).toContain(`38;2;${rgb(DEFAULT_PALETTE.faint)}`)
    })
})
