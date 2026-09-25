/**
 * What the reader configured about tool rows: whether a card starts open, how
 * much of an argument survives, and which clicks the view claims.
 */

import { describe, expect, it } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'
import { cardOfCall, cardOfResult } from '@/cards/presenter.ts'
import { contentLines, type ToolPresenter } from '@/cards.ts'
import { CARD_SHELL_PREVIEW } from '@/cards/preview.ts'
import { TranscriptModel } from '@/transcript.ts'
import { TranscriptView } from '@/ui/view.ts'
import { DEFAULT_TOOL_DISPLAY, toolDisplayTable } from '@/tool-display.ts'
import { COLLAPSED, viewOf, mouse } from './fixtures/transcript-view.ts'

describe('TranscriptView tool display policy', () => {
  /** A shell run of `rows` output lines, through the real card mappers. */
    const shell = (rows: number): TranscriptModel => {
      const output = Array.from({ length: rows }, (_, index) => `row ${index}`)
      const presenter: ToolPresenter = {
        call: name => cardOfCall({ card: 'terminal', title: 'Run echo rows' }, name),
        result: (name, input) => cardOfResult(
          { card: 'terminal', title: 'Run echo rows', output: contentLines(input.content).join('\n'), exitCode: 0 },
          { name, failed: input.isError, contentLines: contentLines(input.content) },
        ),
      }
      const model = new TranscriptModel(presenter)
      model.apply({ type: 'tool/call', data: { name: 'bash', arguments: '{}', callId: 'c1' } })
      model.apply({
        type: 'tool/result',
        data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', text: output.join('\n') }], isError: false } },
      })
      return model
    }
  /** Two folded shell cards, so a click on one can be shown not to touch the other. */
    const pair = (): TranscriptModel => {
      const presenter: ToolPresenter = {
        call: name => cardOfCall({ card: 'terminal', title: 'echo' }, name),
        result: (name, input) => cardOfResult(
          { card: 'terminal', output: contentLines(input.content).join('\n'), exitCode: 0 },
          { name, failed: input.isError, contentLines: contentLines(input.content) },
        ),
      }
      const model = new TranscriptModel(presenter)
      for (const [callId, text] of [['c1', 'one'], ['c2', 'two']] as const) {
        model.apply({ type: 'tool/call', data: { name: 'bash', arguments: '{}', callId } })
        model.apply({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: callId, text }], isError: false } } })
      }
      return model
    }
  it('starts a tool open when the reader configured it that way', () => {
      const view = viewOf(shell(3), COLLAPSED, undefined, toolDisplayTable({ bash: { collapsed: false } }))
      expect(view.render(60).filter(line => line.startsWith('    row '))).toHaveLength(3)
    })
  it('clips the argument to the screen edge, leaving the right edge blank', () => {
      // The facts and the outcome keep their columns: a narrow screen costs the
      // argument, not the answer to "what ran, and how did it end".
      const [line = ''] = viewOf(shell(3), COLLAPSED).render(30)
      expect(visibleWidth(line)).toBe(25)
      expect(line).toContain('…')
      expect(line.endsWith('· exit 0 · 3 lines')).toBe(true)
    })
  it('keeps the configured tail behind a folded card and counts the rest', () => {
      const view = viewOf(shell(25), COLLAPSED, undefined, toolDisplayTable({ bash: { output: 'tail', tail: 2 } }))
      const lines = view.render(60)
      expect(lines.filter(line => line.startsWith('    row '))).toEqual(['    row 23', '    row 24'])
      expect(lines.at(-1)).toBe('    … 23 earlier lines · ctrl+o shows more')
    })
  it('ships the fold the settings document names, not a hard-coded one', () => {
      // The shipped default has to be the one the settings types describe, or a
      // reader who writes nothing gets a different screen than the docs promise.
      const view = viewOf(shell(3), COLLAPSED, undefined, toolDisplayTable())
      expect(view.render(60)).toEqual(['bash Run echo rows · exit 0 · 3 lines'])
      expect(DEFAULT_TOOL_DISPLAY).toEqual({ collapsed: true, output: 'hidden', tail: CARD_SHELL_PREVIEW })
    })
  it('toggles one clicked message and leaves its neighbour alone', () => {
      const view = viewOf(pair())
      const folded = ['bash echo · exit 0 · 1 line', 'bash echo · exit 0 · 1 line']
      expect(view.render(60)).toEqual(folded)
      // A click opens the message under it and nothing else.
      expect(view.handleMouse(mouse('click', 'left', 0))).toEqual({ handled: true, render: true })
      const opened = view.render(60)
      expect(opened).toContain('    one')
      expect(opened.at(-1)).toBe(folded[1])
      // The choice survives the repaints around it, and a second click reverses it.
      expect(view.render(60)).toEqual(opened)
      view.handleMouse(mouse('click', 'left', 0))
      expect(view.render(60)).toEqual(folded)
    })
  it('leaves presses, drags, wheels, and other buttons to the surface', () => {
      const view = viewOf(pair())
      view.render(60)
      for (const event of [mouse('press', 'left', 0), mouse('drag', 'left', 0), mouse('wheel', 'none', 0), mouse('click', 'right', 0)]) {
        expect(view.handleMouse(event)).toBeUndefined()
      }
      expect(view.render(60)).toEqual(['bash echo · exit 0 · 1 line', 'bash echo · exit 0 · 1 line'])
    })
  it('leaves a click outside every card to the transcript itself', () => {
      const view = viewOf(pair())
      view.render(60)
      expect(view.handleMouse(mouse('click', 'left', 9))).toBeUndefined()
    })
})
