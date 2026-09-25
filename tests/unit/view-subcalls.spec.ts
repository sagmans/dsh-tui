/**
 * Nested dispatches: how a program’s calls fall under its card, what a click
 * on one opens, and what retention drops.
 */

import { describe, expect, it } from 'vitest'
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { cardOfCall, cardOfResult } from '@/cards/presenter.ts'
import { contentLines, CARD_DETAIL_MAX, type ToolPresenter } from '@/cards.ts'
import { SUBCALL_MAX } from '@/cards/composition.ts'
import { createTheme } from '@/theme.ts'
import { DEFAULT_PALETTE } from '@/theme-defaults.ts'
import { TranscriptModel } from '@/transcript.ts'
import { MarkdownRenderer } from '@/ui/markdown.ts'
import { TranscriptView, type ViewState } from '@/ui/view.ts'
import { painted, viewOf, mouse } from './fixtures/transcript-view.ts'

describe('TranscriptView nested PTC calls', () => {
  /** Declares each nested call the way the real tools do, so its row is the tool's own header. */
    const nestedPresenter: ToolPresenter = {
      call: (name, argumentsJson) => {
        if (name === 'run_code') return cardOfCall({ card: 'generic', title: 'search the tree' }, name)
        const args = JSON.parse(argumentsJson) as Record<string, unknown>
        if (typeof args.command === 'string') return cardOfCall({ card: 'terminal', title: args.command }, name)
        // An edit declares the change it is about to make, which is the only place
        // its diff exists: the dispatch carries no result metadata to re-present.
        if (typeof args.old_string === 'string') {
          return cardOfCall({ card: 'diff', title: 'Edit', diffs: [{ path: String(args.file_path ?? ''), oldText: args.old_string, newText: String(args.new_string ?? '') }] }, name)
        }
        return cardOfCall({ card: 'generic', title: 'Read', kind: 'read', locations: [{ path: String(args.file_path ?? '') }] }, name)
      },
      result: (name, input) => name === 'bash'
        ? cardOfResult(
            // The real shell reports the exit code it ended on, which is the status a
            // reader sees on the row; a failed call in these fixtures exits non-zero.
            { card: 'terminal', output: contentLines(input.content).join('\n'), exitCode: input.isError ? 1 : 0 },
            { name, failed: input.isError, contentLines: contentLines(input.content) },
          )
        : undefined,
    }
  /** One run_code program, its dispatches, and their results, in the order the log records them. */
    const foldedProgram = (calls: readonly { readonly name: string; readonly args: Record<string, unknown>; readonly failed?: boolean; readonly content?: string }[]): TranscriptModel => {
      const model = new TranscriptModel(nestedPresenter)
      model.apply({ type: 'tool/call', data: { name: 'run_code', arguments: '{"description":"search the tree"}', callId: 'root' } })
      calls.forEach((call, at) => {
        const subCallId = `root:ptc:${at + 1}`
        model.apply({ type: 'tool/ptc-dispatch-start', data: { rootCallId: 'root', parentCallId: 'root', subCallId, name: call.name, arguments: call.args } })
        const content = call.content === undefined ? [] : [{ type: 'text', text: call.content }]
        model.apply({ type: 'tool/ptc-dispatch', data: { rootCallId: 'root', parentCallId: 'root', subCallId, name: call.name, arguments: call.args, isError: call.failed === true, content } })
      })
      model.apply({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'root', text: 'done' }], isError: false } } })
      return model
    }
  const INLINE: ViewState = { expandCards: true, expandReasoning: false, expandSubCalls: true }
  /** The shipped shape: the card folded, the calls it dispatched still legible. */
    const FOLDED: ViewState = { expandCards: false, expandReasoning: false, expandSubCalls: true }
  it('hides a program’s calls when the nested-call toggle is off', () => {
      const lines = viewOf(foldedProgram([{ name: 'read', args: { file_path: 'src/x.ts' } }])).render(60)
      expect(lines[0]).toBe('search the tree')
      expect(lines.some(line => line.includes('src/x.ts'))).toBe(false)
    })
  it('keeps each dispatch on one line under a card that stays folded', () => {
      const model = foldedProgram([
        { name: 'read', args: { file_path: 'src/x.ts' } },
        { name: 'bash', args: { command: 'git status' } },
      ])
      const lines = viewOf(model, FOLDED).render(60)
      expect(lines[0]).toBe('search the tree')
      // Only the call still in flight is marked, so a settled row takes the mark's
      // place and the names read down one column.
      expect(lines.slice(1)).toEqual(['  read src/x.ts', '  bash git status · exit 0'])
    })
  it('keeps a dispatched command that carries a break on one row', () => {
      const model = foldedProgram([{ name: 'bash', args: { command: 'echo one\necho two' } }])
      expect(viewOf(model, FOLDED).render(60)).toEqual(['search the tree', '  bash echo one echo two · exit 0'])
    })
  it('draws each call on one two-space-indented line under the header', () => {
      const model = foldedProgram([
        { name: 'read', args: { file_path: 'src/x.ts' } },
        { name: 'bash', args: { command: 'git status' } },
      ])
      expect(viewOf(model, INLINE).render(60)).toEqual(['search the tree', '  read src/x.ts', '  bash git status · exit 0', '    done'])
    })
  it('marks a failed call in the failed colour without hiding it', () => {
      const colour = createTheme('truecolor')
      const model = foldedProgram([{ name: 'bash', args: { command: 'exit 1' }, failed: true }])
      const lines = new TranscriptView(model, colour, new MarkdownRenderer(colour.markdown), { state: () => INLINE }).render(60)
      // A failed call is not marked: its own name is drawn in the failed colour, so
      // the row a reader scans says which call went wrong and nothing beside it is
      // claimed to have failed.
      expect(stripTerminalSequences(lines[1] ?? '')).toBe('  bash exit 1 · exit 1')
      expect(lines[1]).toContain(painted(DEFAULT_PALETTE.removed))
    })
  it('reports the calls retention dropped', () => {
      const calls = Array.from({ length: SUBCALL_MAX + 1 }, (_, at) => ({ name: 'read', args: { file_path: `src/${at}.ts` } }))
      const lines = viewOf(foldedProgram(calls), INLINE).render(60)
      expect(lines).toContain('  … 1 more calls')
    })
  it('opens a dispatched shell call to the rows it printed', () => {
      const model = foldedProgram([
        { name: 'bash', args: { command: 'echo hi' }, content: 'hi\nthere' },
        { name: 'read', args: { file_path: 'src/y.ts' } },
      ])
      const view = viewOf(model, FOLDED)
      expect(view.render(60)).toEqual(['search the tree', '  bash echo hi · exit 0', '  read src/y.ts'])
      // The output is the reason to open the row, and only the clicked call gets it.
      view.handleMouse(mouse('click', 'left', 1))
      expect(view.render(60)).toEqual(['search the tree', '  bash echo hi · exit 0', '    hi', '    there', '  read src/y.ts'])
      // A click anywhere on the opened call closes it, output and all.
      view.handleMouse(mouse('click', 'left', 2))
      expect(view.render(60)).toEqual(['search the tree', '  bash echo hi · exit 0', '  read src/y.ts'])
    })
  it('clips a call to one row and opens that call when it is clicked', () => {
      const model = foldedProgram([
        { name: 'bash', args: { command: `echo ${'x'.repeat(80)}` } },
        { name: 'read', args: { file_path: 'src/y.ts' } },
      ])
      const view = viewOf(model, FOLDED)
      const folded = view.render(40)
      expect(folded[0]).toBe('search the tree')
      expect(folded[1]?.startsWith('  bash echo ')).toBe(true)
      expect(folded[1] ?? '').toContain('…')
      // The clipped call stops five columns short of the edge, like every other
      // one-line tool row.
      expect(visibleWidth(folded[1] ?? '')).toBe(35)
      expect(folded[2]).toBe('  read src/y.ts')
      for (const line of folded) expect(visibleWidth(line)).toBeLessThanOrEqual(40)
      // The click takes the tightest row it lands on: the call opens in full while
      // the card around it and the call below stay as they were.
      expect(view.handleMouse(mouse('click', 'left', 1))).toEqual({ handled: true, render: true })
      const opened = view.render(40)
      expect(opened[0]).toBe('search the tree')
      expect(opened.at(-1)).toBe('  read src/y.ts')
      // The full argument survives across the wrapped rows, which is the point of
      // opening one call without opening the card around it.
      // The last row ends with the call's own outcome, which is not part of the
      // argument this asserts survived the wrap.
      const wrapped = opened.slice(1, -1).map(row => (row.split(' · ')[0] ?? '').trim()).join('')
      expect(wrapped.split('x')).toHaveLength(81)
      expect(opened.join('')).not.toContain('done')
      for (const line of opened) expect(visibleWidth(line)).toBeLessThanOrEqual(40)
      // Clicking the opened call folds it back to the one line it started as.
      view.handleMouse(mouse('click', 'left', 1))
      expect(view.render(40)).toEqual(folded)
    })
  it('opens a dispatched edit to its diff and its outcome, in that order', () => {
      const colour = createTheme('truecolor')
      const model = foldedProgram([{ name: 'edit', args: { file_path: 'src/x.ts', old_string: 'b', new_string: 'B' }, content: 'The file src/x.ts has been updated successfully.' }])
      const view = new TranscriptView(model, colour, new MarkdownRenderer(colour.markdown), { state: () => FOLDED })
      const folded = view.render(60).map(stripTerminalSequences)
      expect(folded).toEqual(['search the tree', '  edit src/x.ts'])
      // A click only lands on a row the surface has already drawn its hit target on.
      view.handleMouse(mouse('click', 'left', 1))
      const opened = view.render(60)
      expect(opened.map(stripTerminalSequences)).toEqual([
        'search the tree',
        '  edit src/x.ts',
        '    src/x.ts  -1 +1',
        '    -b',
        '    +B',
        '    The file src/x.ts has been updated successfully.',
      ])
      // The change draws in the diff colours, which is what the row is opened for.
      const removed = [1, 3, 5].map(at => Number.parseInt(DEFAULT_PALETTE.removed.slice(at, at + 2), 16))
      const added = [1, 3, 5].map(at => Number.parseInt(DEFAULT_PALETTE.added.slice(at, at + 2), 16))
      expect(opened[3]).toContain(`38;2;${removed.join(';')}`)
      expect(opened[4]).toContain(`38;2;${added.join(';')}`)
      // A click on the drawn diff folds the call back to the one line it started as.
      view.handleMouse(mouse('click', 'left', 4))
      expect(view.render(60).map(stripTerminalSequences)).toEqual(folded)
    })
  it('names the rows retention dropped from what a call opened to', () => {
      const body = Array.from({ length: CARD_DETAIL_MAX + 3 }, (_, at) => `line ${at + 1}`).join('\n')
      const view = viewOf(foldedProgram([{ name: 'read', args: { file_path: 'src/big.ts' }, content: body }]), FOLDED)
      view.render(60)
      view.handleMouse(mouse('click', 'left', 1))
      // The row keeps what the program was shown, and says how much retention refused.
      expect(view.render(60).map(stripTerminalSequences).at(-1)).toBe('    3 more lines not shown')
    })
})
