/**
 * Calls that have not answered: the clock they show, the row a late result
 * replaces, and the fold they keep while they wait.
 */

import { describe, expect, it } from 'vitest'
import { cardOfCall } from '@/cards/presenter.ts'
import { type ToolPresenter } from '@/cards.ts'
import { createTheme } from '@/theme.ts'
import { DEFAULT_PALETTE } from '@/theme-defaults.ts'
import { TranscriptModel, type TranscriptEntry } from '@/transcript.ts'
import { SECOND_MS } from '@/transcript/tool-calls.ts'
import { MarkdownRenderer } from '@/ui/markdown.ts'
import { RowCache } from '@/ui/rows.ts'
import { TranscriptView, type ViewState } from '@/ui/view.ts'
import { theme, bashPresenter, painted, COLLAPSED, OPEN, viewOf } from './fixtures/transcript-view.ts'

describe('TranscriptView running cards', () => {
  /** A clock the test moves, so a duration on a row is an assertion, not a race. */
    const clockAt = (start: number) => {
      const state = { now: start }
      return { state, clock: () => state.now }
    }
  const CALL = { type: 'tool/call', data: { name: 'bash', arguments: '{"command":"pnpm test"}', callId: 'c1' } }
  const RESULT = {
      type: 'tool/result',
      data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', text: 'all green' }], isError: false } },
    }
  /** A view over one call, folded like the shipped default. */
    const runningView = (start = 1_000, state: ViewState = COLLAPSED) => {
      const { state: clockState, clock } = clockAt(start)
      const model = new TranscriptModel(bashPresenter, clock)
      model.apply(CALL)
      return { clockState, model, view: viewOf(model, state) }
    }
  it('marks a call that has not answered, with the time it has been waiting', () => {
      const { clockState, view } = runningView()
      clockState.now += 12 * SECOND_MS
      // The command stays on the row it was drawn on: the state is added in front
      // of it and the duration beside it, rather than replacing what the reader was
      // already reading.
      expect(view.render(60)).toEqual(['bash pnpm test · ~12s'])
    })
  it('shows the running colour alone while the wait is still under a second', () => {
      const { clockState, view } = runningView()
      clockState.now += 400
      // A duration that has to be rounded up from nothing is noise, not a measurement.
      expect(view.render(60)).toEqual(['bash pnpm test'])
    })
  it('drops the running colour and reports the outcome when the result lands', () => {
      const { clockState, model, view } = runningView()
      clockState.now += 12 * SECOND_MS
      expect(view.render(60)).toEqual(['bash pnpm test · ~12s'])
      model.apply(RESULT)
      // The settled row reports what the call produced, which supersedes the wait.
      expect(view.render(60)).toEqual(['bash pnpm test · exit 0 · 1 line'])
    })
  it('keeps the running colour on an opened card', () => {
      const { clockState, view } = runningView(1_000, OPEN)
      clockState.now += 3 * SECOND_MS
      expect(view.render(60)).toEqual(['bash · ~3s', '    pnpm test'])
    })
  it("leaves a settled card's elapsed time out of the row it keeps", () => {
      const { clockState, model, view } = runningView()
      clockState.now += 9 * SECOND_MS
      expect(view.render(60).join('')).toContain('~9s')
      model.apply(RESULT)
      // A settled row must not keep a duration that keeps growing after the call
      // came back; the number it reports from here is the outcome's own.
      expect(view.render(60).join('')).not.toContain('~')
    })
  it('marks the dispatch the program is waiting on inside a PTC card', () => {
      const { state: clockState, clock } = clockAt(1_000)
      // The shell answers for bash alone, so the root keeps the fallback row a
      // presenter-less run_code would draw.
      const shell: ToolPresenter = {
        call: (name, argumentsJson) => (name === 'bash'
          ? cardOfCall({ card: 'terminal', title: (JSON.parse(argumentsJson) as { command?: string }).command ?? '' }, name)
          : undefined),
        result: () => undefined,
      }
      const model = new TranscriptModel(shell, clock)
      model.apply({ type: 'tool/call', data: { name: 'run_code', arguments: '{"code":"x"}', callId: 'root' } })
      model.apply({
        type: 'tool/ptc-dispatch-start',
        data: { rootCallId: 'root', parentCallId: 'root', subCallId: 'root:ptc:1', name: 'bash', arguments: { command: 'echo hi' } },
      })
      const inline: ViewState = { expandCards: false, expandReasoning: false, expandSubCalls: true }
      clockState.now += 12 * SECOND_MS
      // The program's own row carries the timer and nothing else: it is the clock a
      // reader watches, and the calls underneath it are what it is spending time on.
      expect(viewOf(model, inline).render(60)).toEqual(['run_code · ~12s', '  bash echo hi'])
  
      model.apply({
        type: 'tool/ptc-dispatch',
        data: { rootCallId: 'root', parentCallId: 'root', subCallId: 'root:ptc:1', name: 'bash', arguments: { command: 'echo hi' }, isError: false, content: [] },
      })
      expect(viewOf(model, inline).render(60)).toEqual(['run_code · ~12s', '  bash echo hi'])
    })
  it('marks only the call a program is still waiting on', () => {
      const { state: clockState, clock } = clockAt(1_000)
      const model = new TranscriptModel(bashPresenter, clock)
      model.apply({ type: 'tool/call', data: { name: 'run_code', arguments: '{"code":"x"}', callId: 'root' } })
      const start = (id: string, command: string) => model.apply({
        type: 'tool/ptc-dispatch-start',
        data: { rootCallId: 'root', parentCallId: 'root', subCallId: id, name: 'bash', arguments: { command } },
      })
      const land = (id: string, command: string, isError: boolean) => model.apply({
        type: 'tool/ptc-dispatch',
        data: { rootCallId: 'root', parentCallId: 'root', subCallId: id, name: 'bash', arguments: { command }, isError, content: [] },
      })
      start('root:ptc:1', 'echo first')
      land('root:ptc:1', 'echo first', false)
      start('root:ptc:2', 'exit 3')
      land('root:ptc:2', 'exit 3', true)
      start('root:ptc:3', 'sleep 30')
      const inline: ViewState = { expandCards: false, expandReasoning: false, expandSubCalls: true }
      clockState.now += 4 * SECOND_MS
      // The call still in flight is the only row that sits further in: the two that
      // are back say how they ended, and the one that failed says it in its own
      // name, so the mark means one thing on every row of the card.
      expect(viewOf(model, inline).render(60)).toEqual([
        'run_code · ~4s',
        '  bash echo first · exit 0',
        '  bash exit 3 · exit 1',
        '  bash sleep 30',
      ])
    })
  it('keeps the total a program took after it answers, and stops counting', () => {
      const rows = new RowCache<TranscriptEntry>()
      const { state: clockState, clock } = clockAt(1_000)
      const model = new TranscriptModel(undefined, clock)
      model.apply({ type: 'tool/call', data: { name: 'run_code', arguments: '{"code":"x"}', callId: 'root' } })
      model.apply({
        type: 'tool/ptc-dispatch-start',
        data: { rootCallId: 'root', parentCallId: 'root', subCallId: 'root:ptc:1', name: 'bash', arguments: { command: 'echo hi' } },
      })
      const inline: ViewState = { expandCards: false, expandReasoning: false, expandSubCalls: true }
      const view = new TranscriptView(model, theme, new MarkdownRenderer(theme.markdown), { rows, state: () => inline })
      clockState.now += 10 * SECOND_MS
      expect(view.render(60)[0]).toBe('run_code · ~10s')
  
      // Nothing may be left in flight, or the row would keep being rebuilt and the
      // seconds it settled on would never be the row the cache holds.
      model.apply({
        type: 'tool/ptc-dispatch',
        data: { rootCallId: 'root', parentCallId: 'root', subCallId: 'root:ptc:1', name: 'bash', arguments: { command: 'echo hi' }, isError: false, content: [] },
      })
      model.apply({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'root', text: 'done' }], isError: false } } })
      const settled = view.render(60)
      expect(settled[0]).toContain('~10s')
      const misses = rows.stats().misses
      clockState.now += 30 * SECOND_MS
      // The total belongs to the run, not to the clock: a program that answered
      // keeps the row it settled into, at the seconds it actually took.
      expect(view.render(60)).toEqual(settled)
      expect(rows.stats().misses).toBe(misses)
    })
  it('paints the name rather than marking it, in the colour of the state it is in', () => {
      const colour = createTheme('truecolor')
      const { state: clockState, clock } = clockAt(1_000)
      const model = new TranscriptModel(bashPresenter, clock)
      model.apply(CALL)
      clockState.now += 5 * SECOND_MS
      const row = (): string => new TranscriptView(model, colour, new MarkdownRenderer(colour.markdown), { state: () => COLLAPSED }).render(60)[0] ?? ''
      // The name is what a state repaints, and a settled row's stats are free to
      // keep colours of their own, so the paint before the name is what is read.
      const paintBeforeName = (text: string): string => text.slice(0, text.indexOf('bash'))
      // A state is a colour on a word the reader needs either way, so there is no
      // glyph to learn and none to lose: one name, painted two ways.
      expect(paintBeforeName(row())).toContain(painted(DEFAULT_PALETTE.warn))
      model.apply(RESULT)
      expect(paintBeforeName(row())).not.toContain(painted(DEFAULT_PALETTE.warn))
    })
  it('draws the name plainly when the reader has turned the running colour off', () => {
      const { clockState, model } = runningView()
      clockState.now += 5 * SECOND_MS
      const blind = createTheme('none', { palette: DEFAULT_PALETTE, tokens: new Map([['tool.running.title', { hidden: true }]]) })
      const view = new TranscriptView(model, blind, new MarkdownRenderer(blind.markdown), { state: () => COLLAPSED })
      // The colour is what a state token takes away: a reader who turned the running
      // colour off still has to be able to see which tool is running, and the
      // measurement is what still says it has not come back.
      expect(view.render(60)).toEqual(['bash pnpm test · ~5s'])
    })
  it('draws the total a program kept quieter than the timer it counted with', () => {
      /** Whether a row carries the italic attribute, whatever else it is painted with. */
      const italic = (row: string): boolean =>
        [...row.matchAll(/\u001B\[([0-9;]*)m/g)].some(match => (match[1] ?? '').split(';').includes('3'))
      const painted = createTheme('256')
      const { state: clockState, clock } = clockAt(1_000)
      const model = new TranscriptModel(undefined, clock)
      model.apply({ type: 'tool/call', data: { name: 'run_code', arguments: '{"code":"x"}', callId: 'root' } })
      model.apply({
        type: 'tool/ptc-dispatch-start',
        data: { rootCallId: 'root', parentCallId: 'root', subCallId: 'root:ptc:1', name: 'bash', arguments: { command: 'echo hi' } },
      })
      model.apply({
        type: 'tool/ptc-dispatch',
        data: { rootCallId: 'root', parentCallId: 'root', subCallId: 'root:ptc:1', name: 'bash', arguments: { command: 'echo hi' }, isError: false, content: [] },
      })
      const inline: ViewState = { expandCards: false, expandReasoning: false, expandSubCalls: true }
      const view = new TranscriptView(model, painted, new MarkdownRenderer(painted.markdown), { state: () => inline })
      clockState.now += 10 * SECOND_MS
      const counting = view.render(60)[0] ?? ''
      expect(counting).toContain('~10s')
      // A moving measurement is stated plainly; the total that replaces it is what
      // the reader is meant to stop reading, so it is the one that slants.
      expect(italic(counting)).toBe(false)
  
      model.apply({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'root', text: 'done' }], isError: false } } })
      const settled = view.render(60)[0] ?? ''
      expect(settled).toContain('~10s')
      expect(italic(settled)).toBe(true)
    })
  it('draws no total on a program that answered when the reader turned the total off', () => {
      const { state: clockState, clock } = clockAt(1_000)
      const model = new TranscriptModel(undefined, clock)
      model.apply({ type: 'tool/call', data: { name: 'run_code', arguments: '{"code":"x"}', callId: 'root' } })
      model.apply({
        type: 'tool/ptc-dispatch-start',
        data: { rootCallId: 'root', parentCallId: 'root', subCallId: 'root:ptc:1', name: 'bash', arguments: { command: 'echo hi' } },
      })
      const inline: ViewState = { expandCards: false, expandReasoning: false, expandSubCalls: true }
      clockState.now += 10 * SECOND_MS
      model.apply({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'root', text: 'done' }], isError: false } } })
      const blind = createTheme('none', { palette: DEFAULT_PALETTE, tokens: new Map([['tool.elapsed.done', { hidden: true }]]) })
      const view = new TranscriptView(model, blind, new MarkdownRenderer(blind.markdown), { state: () => inline })
      // The counting timer and the kept total are separate elements, so a reader can
      // keep being told a call is in flight without being told how long it ran.
      expect(view.render(60)[0]).not.toContain('~')
    })
  it('draws no mark on a dispatched row when the reader has turned that mark off', () => {
      const { state: clockState, clock } = clockAt(1_000)
      const model = new TranscriptModel(bashPresenter, clock)
      model.apply({ type: 'tool/call', data: { name: 'run_code', arguments: '{"code":"x"}', callId: 'root' } })
      model.apply({
        type: 'tool/ptc-dispatch-start',
        data: { rootCallId: 'root', parentCallId: 'root', subCallId: 'root:ptc:1', name: 'bash', arguments: { command: 'echo hi' } },
      })
      const inline: ViewState = { expandCards: false, expandReasoning: false, expandSubCalls: true }
      const blind = createTheme('none', { palette: DEFAULT_PALETTE, tokens: new Map([['tool.subcall.running', { hidden: true }]]) })
      const view = new TranscriptView(model, blind, new MarkdownRenderer(blind.markdown), { state: () => inline })
      clockState.now += 2 * SECOND_MS
      expect(view.render(60).at(-1)).toBe('  bash echo hi')
    })
  it('draws no timer at all when the reader has turned the timer off', () => {
      const { clockState, model } = runningView()
      clockState.now += 5 * SECOND_MS
      const blind = createTheme('none', { palette: DEFAULT_PALETTE, tokens: new Map([['tool.running.elapsed', { hidden: true }]]) })
      const view = new TranscriptView(model, blind, new MarkdownRenderer(blind.markdown), { state: () => COLLAPSED })
      // Hiding the timer leaves the mark that introduced it, so the row still says
      // the call is in flight without reporting how long it has been.
      expect(view.render(60)).toEqual(['bash pnpm test'])
    })
})
