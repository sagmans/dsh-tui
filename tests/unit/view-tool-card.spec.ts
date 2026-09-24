/**
 * How tool cards draw: their titles as the terminal that wrote them spells
 * them, their fold and expansion, the facts they measure, and what a click on
 * one of them opens.
 */

import { describe, expect, it } from 'vitest'
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { cardOfCall, cardOfResult } from '@/cards/presenter.ts'
import { contentLines, CARD_DETAIL_MAX, type ToolPresenter } from '@/cards.ts'
import { createTheme } from '@/theme.ts'
import { DEFAULT_PALETTE } from '@/theme-defaults.ts'
import { TranscriptModel } from '@/transcript.ts'
import { MarkdownRenderer } from '@/ui/markdown.ts'
import { TranscriptView, type ViewState } from '@/ui/view.ts'
import { COLLAPSED, OPEN, viewOf, toolCall, toolResult, mouse } from './fixtures/transcript-view.ts'

describe('TranscriptView text', () => {
  it('draws a title the way the terminal that wrote it would have', () => {
      // Any sequence the presenter hands over is read here: what a terminal would
      // act on cannot reach the row, and what is really text still can.
      const model = new TranscriptModel({
        call: () => ({ kind: 'generic', tool: 'bash', title: '\u001b[31mred\u0007', detail: [], failed: false, totalLines: 0 }),
        result: () => undefined,
      })
      model.apply(toolCall())
      model.apply(toolResult('plain'))
      const rendered = viewOf(model).render(60).join('\n')
      // These rows run with colour off, so the colour sequence is consumed rather
      // than shown; a bell is not a sequence, so it is spelled, not swallowed.
      expect(rendered).toContain('red\\x07')
      expect(rendered).not.toContain('\u001b')
    })
  it('keeps a tool colour the terminal can draw, and still spells a stray control', () => {
      const colour = createTheme('truecolor')
      const model = new TranscriptModel({
        call: () => ({ kind: 'generic', tool: 'bash', title: '\u001b[31mred\u001b[0mplain\u0007', detail: [], failed: false, totalLines: 0 }),
        result: () => undefined,
      })
      model.apply(toolCall())
      model.apply(toolResult('plain'))
      const view = new TranscriptView(model, colour, new MarkdownRenderer(colour.markdown), { state: () => COLLAPSED })
      const rendered = view.render(60).join('\n')
      expect(rendered).toContain('\u001b[38;5;1mred')
      expect(rendered).toContain('plain\\x07')
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
  it('folds a tool card to its title and says nothing about a body it can still open', () => {
      // One line, and not even a hint: a card that keeps no row has nothing to
      // count, so the fold is silent about a body ctrl+o can still open.
      expect(viewOf(withRows(25)).render(60)).toEqual(['Read {"path":"a.ts"}'])
    })
  it('shows every row once a folded card is opened with ctrl+o', () => {
      const lines = viewOf(withRows(25), { expandCards: true, expandReasoning: false, expandSubCalls: false }).render(60)
      expect(lines.filter(line => line.startsWith('    row '))).toHaveLength(25)
      expect(lines.some(line => line.includes('ctrl+o'))).toBe(false)
    })
  it('folds a shell run to one row that keeps its command, outcome, and hidden rows', () => {
      const lines = viewOf(withRows(25, 'bash')).render(60)
      // One row is the whole contract of the fold; the facts a reader needs without
      // opening it — what ran, how it ended, how much sits behind it — ride that row.
      expect(lines).toEqual(['bash Run echo rows · exit 0 · 25 lines'])
    })
  it('shows a shell card whole once it is opened, and a short one without a hint', () => {
      const opened = viewOf(withRows(25, 'bash'), OPEN).render(60)
      expect(opened[0]).toBe('bash')
      expect(opened[1]).toBe('    Run echo rows')
      expect(opened.filter(line => line.startsWith('    row '))).toHaveLength(25)
      expect(opened.some(line => line.includes('earlier lines'))).toBe(false)
      const short = viewOf(withRows(3, 'bash'), OPEN).render(60)
      expect(short.filter(line => line.startsWith('    row '))).toHaveLength(3)
      // The label, the command, three output rows, and the exit status.
      expect(short).toHaveLength(6)
      expect(short.at(-1)).toBe('    exit 0')
      // Folded, the output is behind the fold whatever its size, so the row says
      // how many lines are waiting there.
      expect(viewOf(withRows(3, 'bash')).render(60)).toEqual(['bash Run echo rows · exit 0 · 3 lines'])
    })
  it("names an opened shell card's dropped rows as the earlier ones", () => {
      // Retention keeps the tail, so opening a run past the cap reveals its end
      // and hides its beginning; a neutral count would point the reader past the
      // last row on screen for rows that are above it.
      const opened = viewOf(withRows(250, 'bash'), OPEN).render(60)
      expect(opened.filter(line => line.startsWith('    row '))).toHaveLength(CARD_DETAIL_MAX)
      expect(opened).toContain('    exit 0')
      expect(opened.at(-1)).toBe('    … 50 earlier lines not shown')
    })
  it("keeps a failed shell card's command, outcome, and title folded, and its output when opened", () => {
      // Built through the real card mappers so the assertion covers the shell
      // shape a failing command actually produces, not a hand-made card.
      const failing: ToolPresenter = {
        call: name => cardOfCall({ card: 'terminal', title: 'rm -rf /tmp/x' }, name),
        result: (name, input) => cardOfResult(
          { card: 'terminal', output: 'boom', exitCode: 1 },
          { name: name, failed: input.isError, contentLines: contentLines(input.content) },
        ),
      }
      const model = new TranscriptModel(failing)
      model.apply({ type: 'tool/call', data: { name: 'bash', arguments: '{}', callId: 'c1' } })
      model.apply({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', text: 'boom' }], isError: true } } })
      // Folded, the failure is still legible: the command, the exit code, and the
      // one row behind it; opening it shows what actually came back.
      expect(viewOf(model).render(60)).toEqual(['bash rm -rf /tmp/x · exit 1 · 1 line'])
      const opened = viewOf(model, OPEN).render(60)
      expect(opened).toContain('    boom')
      expect(opened).toContain('    exit 1')
    })
  it('shows the output a clicked shell card kept', () => {
      const view = viewOf(withRows(3, 'bash'))
      expect(view.render(60)).toEqual(['bash Run echo rows · exit 0 · 3 lines'])
      // A click opens the one card and reveals what the command printed.
      view.handleMouse(mouse('click', 'left', 0))
      const opened = view.render(60)
      expect(opened.filter(line => line.startsWith('    row '))).toHaveLength(3)
      expect(opened).toContain('    exit 0')
    })
})

describe('TranscriptView theming', () => {
  const userModel = (): TranscriptModel => {
      const model = new TranscriptModel()
      model.apply({ type: 'user/message', data: { content: [{ type: 'text', text: 'hello there' }], source: { kind: 'user' } } })
      return model
    }
  it('draws no empty indented row when every part of a card row is hidden', () => {
      const model = new TranscriptModel()
      model.apply(toolCall())
      model.apply(toolResult('boom'))
      const hidden = createTheme('truecolor', { palette: DEFAULT_PALETTE, tokens: new Map([['tool.generic.detail', { hidden: true }]]) })
      const lines = new TranscriptView(model, hidden, new MarkdownRenderer(hidden.markdown), { state: () => COLLAPSED }).render(60)
      expect(lines.filter(line => line.trim() === '' && line !== '')).toEqual([])
    })
})

describe('TranscriptView tool args and stats', () => {
  /** Fold one call and result through a presenter, so the merge is what renders. */
    const folded = (name: string, presenter: ToolPresenter, width = 80, state: ViewState = COLLAPSED): string[] => {
      const model = new TranscriptModel(presenter)
      model.apply({ type: 'tool/call', data: { name, arguments: '{}', callId: 'c1' } })
      model.apply({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', text: 'body' }], isError: false } } })
      return viewOf(model, state).render(width)
    }
  it('shows a read path with its range, size, and tokens on the folded line', () => {
      const presenter: ToolPresenter = {
        call: name => cardOfCall({ card: 'generic', title: 'Read a.ts (from line 5)', kind: 'read', locations: [{ path: 'a.ts', line: 5 }] }, name),
        result: (name, input) => cardOfResult(
          { card: 'read', path: 'a.ts', offset: 5, lines: [{ number: 5, text: 'x' }, { number: 6, text: 'y' }], totalLines: 20 },
          { name: name, failed: input.isError, contentLines: contentLines(input.content) },
        ),
      }
      expect(folded('read', presenter)).toEqual(['read a.ts  L5–6 · 2 lines · 1 tok'])
    })
  it('shows a new file by its line and token size', () => {
      const presenter: ToolPresenter = {
        call: name => cardOfCall({ card: 'diff', title: 'Write a.txt', diffs: [{ path: 'a.txt', oldText: null, newText: 'one\ntwo\nthree' }] }, name),
        result: (name, input) => cardOfResult(
          { card: 'diff', diffs: [{ path: 'a.txt', oldText: null, newText: 'one\ntwo\nthree' }] },
          { name: name, failed: input.isError, contentLines: contentLines(input.content) },
        ),
      }
      expect(folded('write', presenter)).toEqual(['write a.txt  3 lines · 4 tok'])
    })
  it('shows an edit split into added and changed lines', () => {
      const diffs = [{ path: 'a.ts', oldText: 'a\nb', newText: 'a\nx\ny' }]
      const presenter: ToolPresenter = {
        call: name => cardOfCall({ card: 'diff', title: 'Edit a.ts', diffs }, name),
        result: (name, input) => cardOfResult(
          { card: 'diff', diffs },
          { name: name, failed: input.isError, contentLines: contentLines(input.content) },
        ),
      }
      expect(folded('edit', presenter)).toEqual(['edit a.ts  +1 · ~1'])
    })
  it('hides a stat whose token the reader turned off', () => {
      const diffs = [{ path: 'a.ts', oldText: 'a\nb', newText: 'a\nx\ny' }]
      const presenter: ToolPresenter = {
        call: name => cardOfCall({ card: 'diff', title: 'Edit a.ts', diffs }, name),
        result: (name, input) => cardOfResult(
          { card: 'diff', diffs },
          { name: name, failed: input.isError, contentLines: contentLines(input.content) },
        ),
      }
      const model = new TranscriptModel(presenter)
      model.apply({ type: 'tool/call', data: { name: 'edit', arguments: '{}', callId: 'c1' } })
      model.apply({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', text: 'body' }], isError: false } } })
      const muted = createTheme('none', { palette: DEFAULT_PALETTE, tokens: new Map([['tool.stat.added', { hidden: true }]]) })
      const lines = new TranscriptView(model, muted, new MarkdownRenderer(muted.markdown), { state: () => COLLAPSED }).render(80)
      expect(lines).toEqual(['edit a.ts  ~1'])
    })
  it('wraps a command wider than the screen instead of cutting it', () => {
      const command = `/bin/echo ${'x'.repeat(60)}`
      const presenter: ToolPresenter = {
        call: name => cardOfCall({ card: 'terminal', title: command }, name),
        result: (name, input) => cardOfResult(
          { card: 'terminal', output: 'ok', exitCode: 0 },
          { name: name, failed: input.isError, contentLines: contentLines(input.content) },
        ),
      }
      const lines = folded('bash', presenter, 40, OPEN)
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(40)
      // Word wrapping drops the whitespace it broke on, so compare without it.
      expect(lines.join('').replace(/\s+/gu, '')).toContain(command.replace(/\s+/gu, ''))
    })
  it('wraps a long argument and keeps its stats instead of cutting the tail', () => {
      const path = `/tmp/${'nested/'.repeat(8)}file.ts`
      const presenter: ToolPresenter = {
        call: name => cardOfCall({ card: 'generic', title: 'Read', kind: 'read', locations: [{ path }] }, name),
        result: (name, input) => cardOfResult(
          { card: 'read', path, offset: 1, lines: [{ number: 1, text: 'x' }], totalLines: 1 },
          { name: name, failed: input.isError, contentLines: contentLines(input.content) },
        ),
      }
      const lines = folded('read', presenter, 40, OPEN)
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(40)
      // The stats are as much the fold's answer as the path is, so neither may be
      // dropped at the edge the way a plain cut dropped them.
      const flat = lines.join('').replace(/\s+/gu, '')
      expect(flat).toContain(path)
      expect(flat).toContain('1tok')
    })
  it('shows a skill card without the presenter verb in front of it', () => {
      const presenter: ToolPresenter = {
        call: name => cardOfCall({ card: 'generic', title: 'Load skill project-skill', kind: 'read', rawInput: 'project-skill' }, name),
        result: () => undefined,
      }
      expect(folded('skill', presenter)).toEqual(['skill project-skill'])
    })
  it('measures a wrapped command by its visible width, not its escape bytes', () => {
      // A styled argument carries escapes through the wrap; if those count as
      // columns the card overflows the terminal it was cut for.
      const command = `/bin/echo ${'x'.repeat(60)}`
      const presenter: ToolPresenter = {
        call: name => cardOfCall({ card: 'terminal', title: command }, name),
        result: (name, input) => cardOfResult(
          { card: 'terminal', output: 'ok', exitCode: 0 },
          { name: name, failed: input.isError, contentLines: contentLines(input.content) },
        ),
      }
      const colour = createTheme('truecolor')
      const model = new TranscriptModel(presenter)
      model.apply({ type: 'tool/call', data: { name: 'bash', arguments: '{}', callId: 'c1' } })
      model.apply({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', text: 'ok' }], isError: false } } })
      const lines = new TranscriptView(model, colour, new MarkdownRenderer(colour.markdown), { state: () => OPEN }).render(40)
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40)
      expect(stripTerminalSequences(lines.join('')).replace(/\s+/gu, '')).toContain(command.replace(/\s+/gu, ''))
    })
  it('folds a long command onto one row, cut at the screen rather than wrapped', () => {
      const command = `/bin/echo ${'x'.repeat(60)}`
      const presenter: ToolPresenter = {
        call: name => cardOfCall({ card: 'terminal', title: command }, name),
        result: (name, input) => cardOfResult(
          { card: 'terminal', output: 'ok', exitCode: 0 },
          { name, failed: input.isError, contentLines: contentLines(input.content) },
        ),
      }
      const lines = folded('bash', presenter, 30)
      // The fold's whole promise is one row, so the argument is clipped and the row
      // is cut at the edge; the reader sees it was cut and can open it whole.
      expect(lines).toHaveLength(1)
      expect(visibleWidth(lines[0] ?? '')).toBeLessThanOrEqual(30)
      expect(stripTerminalSequences(lines[0] ?? '')).toContain('…')
    })
})

describe('TranscriptView tool card clicks', () => {
  /** The shipped fold: one row per card, so a click has something to open. */
    const FOLDED: ViewState = { expandCards: false, expandReasoning: false, expandSubCalls: false }
  const EDIT_ARGS = '{"file_path":"/tmp/x","old_string":"b","new_string":"B"}'
  /** A presenter whose edit declares a diff, which is the card the reader clicks. */
    const editPresenter: ToolPresenter = {
      call: name => cardOfCall({ card: 'diff', title: 'Edit', diffs: [{ path: '/tmp/x', oldText: 'b', newText: 'B' }] }, name),
      result: (name, input) => (input.isError
        ? undefined
        : cardOfResult({ card: 'diff', diffs: [{ path: '/tmp/x', oldText: 'b', newText: 'B' }] }, { name, failed: false, contentLines: contentLines(input.content) })),
    }
  it('opens a clicked edit card to the diff it declared', () => {
      const model = new TranscriptModel(editPresenter)
      model.apply({ type: 'tool/call', data: { name: 'edit', arguments: EDIT_ARGS, callId: 'c1' } })
      model.apply(toolResult('updated'))
      const view = viewOf(model, FOLDED)
      expect(view.render(60)).toEqual(['edit /tmp/x  ~1'])
      view.handleMouse(mouse('click', 'left', 0))
      const opened = view.render(60).map(stripTerminalSequences)
      expect(opened).toContain('    /tmp/x  -1 +1')
      expect(opened).toContain('    -b')
      expect(opened).toContain('    +B')
      // Clicking the drawn diff folds the card back to its one row.
      view.handleMouse(mouse('click', 'left', 2))
      expect(view.render(60)).toEqual(['edit /tmp/x  ~1'])
    })
  it('opens a clicked failed card to the reason it failed', () => {
      const reason = 'Error: cannot modify "/tmp/x": file has not been read — read the file, then retry'
      const model = new TranscriptModel(editPresenter)
      model.apply({ type: 'tool/call', data: { name: 'edit', arguments: EDIT_ARGS, callId: 'c1' } })
      model.apply({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', text: reason }], isError: true } } })
      const view = viewOf(model, FOLDED)
      // Wide enough for the whole reason, because that is what a reader opens the
      // row to read: a narrow screen clips it like any other row.
      view.render(100)
      view.handleMouse(mouse('click', 'left', 0))
      expect(view.render(100).map(stripTerminalSequences)).toContain(`    ${reason}`)
    })
})
