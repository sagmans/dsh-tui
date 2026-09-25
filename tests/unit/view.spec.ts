/**
 * The view as the coordinator the surface renders through: repaint scheduling,
 * theme revisions that invalidate cached rows, and what copy takes from a
 * transcript that the other view suites never assemble.
 */

import { describe, expect, it } from 'vitest'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { createTheme, forwardEditorTheme, forwardMarkdownTheme, type TuiTheme } from '@/theme.ts'
import { DEFAULT_PALETTE } from '@/theme-defaults.ts'
import { TranscriptModel, type TranscriptEntry } from '@/transcript.ts'
import { SECOND_MS } from '@/transcript/tool-calls.ts'
import { cleanCopied } from '@/ui/copy.ts'
import { MarkdownRenderer } from '@/ui/markdown.ts'
import { RowCache } from '@/ui/rows.ts'
import { TranscriptView } from '@/ui/view.ts'
import { theme, bashPresenter, COLLAPSED, viewOf } from './fixtures/transcript-view.ts'

describe('TranscriptView repaints', () => {
  it('reuses the rows it already built instead of re-wrapping the transcript', () => {
      const rows = new RowCache<TranscriptEntry>()
      const model = new TranscriptModel()
      model.apply({ type: 'user/message', data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } })
      model.apply({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'hi' }] } } })
      const view = new TranscriptView(model, theme, new MarkdownRenderer(theme.markdown), { rows })
  
      const first = view.render(80)
      expect(rows.stats()).toEqual({ hits: 0, misses: 2 })
      expect(view.render(80)).toEqual(first)
      expect(rows.stats()).toEqual({ hits: 2, misses: 2 })
    })
  it('rebuilds when a resize or an expansion changes what the rows say', () => {
      const rows = new RowCache<TranscriptEntry>()
      const model = new TranscriptModel()
      model.apply({ type: 'user/message', data: { content: [{ type: 'text', text: 'hello there' }], source: { kind: 'user' } } })
      const state = { expandCards: false, expandReasoning: false, expandSubCalls: false }
      const view = new TranscriptView(model, theme, new MarkdownRenderer(theme.markdown), { rows, state: () => state })
  
      view.render(80)
      expect(rows.stats().misses).toBe(1)
      view.render(40)
      expect(rows.stats().misses).toBe(2)
      state.expandCards = true
      view.render(40)
      expect(rows.stats().misses).toBe(3)
      // The nested-call flag is part of the tag too, or a toggle would reuse the
      // rows drawn before the calls were meant to be on screen.
      state.expandSubCalls = true
      view.render(40)
      expect(rows.stats().misses).toBe(4)
    })
  it('rebuilds a running row as its duration moves and never a settled one', () => {
      const rows = new RowCache<TranscriptEntry>()
      const clockState = { now: 1_000 }
      const model = new TranscriptModel(bashPresenter, () => clockState.now)
      model.apply({ type: 'tool/call', data: { name: 'bash', arguments: '{"command":"pnpm test"}', callId: 'c1' } })
      const view = new TranscriptView(model, theme, new MarkdownRenderer(theme.markdown), { rows })
  
      expect(view.render(60)).toEqual(['bash pnpm test'])
      // Within the same second the row cannot have changed, so the frame reuses it.
      expect(view.render(60)).toEqual(['bash pnpm test'])
      expect(rows.stats()).toEqual({ hits: 1, misses: 1 })
  
      clockState.now += SECOND_MS
      expect(view.render(60)).toEqual(['bash pnpm test · ~1s'])
      expect(rows.stats()).toEqual({ hits: 1, misses: 2 })
  
      model.apply({
        type: 'tool/result',
        data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', text: 'all green' }], isError: false } },
      })
      expect(view.render(60)).toEqual(['bash pnpm test · exit 0 · 1 line'])
      clockState.now += 30 * SECOND_MS
      // A call that came back stops being redrawn: the row it settled into is the
      // one the cache keeps, and nothing on it is measured by the clock any more.
      expect(view.render(60)).toEqual(['bash pnpm test · exit 0 · 1 line'])
      expect(rows.stats()).toEqual({ hits: 2, misses: 3 })
    })
})

describe('TranscriptView theming', () => {
  const userModel = (): TranscriptModel => {
      const model = new TranscriptModel()
      model.apply({ type: 'user/message', data: { content: [{ type: 'text', text: 'hello there' }], source: { kind: 'user' } } })
      return model
    }
  it('rebuilds cached rows when the theme revision moves', () => {
      let active = createTheme('truecolor')
      const delegate: TuiTheme = {
        get revision() { return active.revision },
        get color() { return active.color },
        style: (token, text) => active.style(token, text),
        rich: (raw, options) => active.rich(raw, options),
        cut: (text, width, ellipsis) => active.cut(text, width, ellipsis),
        glyph: token => active.glyph(token),
        visible: token => active.visible(token),
        editor: forwardEditorTheme(() => active.editor),
        markdown: forwardMarkdownTheme(() => active.markdown),
      }
      const markdown = new MarkdownRenderer(delegate.markdown)
      const view = new TranscriptView(userModel(), delegate, markdown, { state: () => COLLAPSED })
      // Derived rather than repeated: this test is about the cache rebuilding,
      // not about which shade the prompt wears.
      const shipped = [1, 3, 5].map(at => Number.parseInt(DEFAULT_PALETTE.user.slice(at, at + 2), 16))
      expect(view.render(60).join('\n')).toContain(`38;2;${shipped.join(';')}`)
      active = createTheme('truecolor', { palette: DEFAULT_PALETTE, tokens: new Map([['transcript.user', { fg: '#ff0000' }]]) })
      // A settings change drops both caches, as the surface does; the row cache is
      // keyed to the old revision, so the repaint re-draws the row under the new table.
      markdown.invalidate()
      expect(view.render(60).join('\n')).toContain('38;2;255;0;0')
    })
})

describe('TranscriptView copy', () => {
  /** The rows of a frame as the terminal hands a copy back: styling gone, trailing blanks gone. */
    const handedBack = (rows: readonly string[]): string => rows.map(row => stripTerminalSequences(row).trimEnd()).join('\n')
  it('reads a dragged copy back as the message, without the box it was drawn in', () => {
      const model = new TranscriptModel()
      model.apply({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'the answer' }] } } })
      const view = viewOf(model)
      const rows = view.render(40)
      // A drag over the box takes its sides with it; what the reader asked for is
      // what has to come back.
      expect(handedBack(rows)).toContain('│')
      expect(cleanCopied(handedBack(rows), view.copyRows())).toBe('the answer')
    })
  it('keeps two messages apart while dropping both of their frames', () => {
      const model = new TranscriptModel()
      model.apply({ type: 'user/message', data: { content: [{ type: 'text', text: 'ask' }], source: { kind: 'user' } } })
      model.apply({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'tell' }] } } })
      const view = viewOf(model)
      expect(cleanCopied(handedBack(view.render(40)), view.copyRows())).toBe('ask\ntell')
    })
  it('reads a reply that is still arriving back as its words', () => {
      const model = new TranscriptModel()
      model.applyStreamChunk({ type: 'text-delta', text: 'streaming reply' })
      const view = viewOf(model)
      const rows = view.render(40)
      // A live row is rebuilt every frame and has no entry to be kept under, so the
      // render itself has to answer for it.
      expect(handedBack(rows)).toContain('│')
      expect(cleanCopied(handedBack(rows), view.copyRows())).toBe('streaming reply')
    })
  it('keeps a live reply in the account beside a settled one', () => {
      const model = new TranscriptModel()
      model.apply({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'settled answer' }] } } })
      model.applyStreamChunk({ type: 'text-delta', text: 'streaming reply' })
      const view = viewOf(model)
      expect(cleanCopied(handedBack(view.render(40)), view.copyRows())).toBe('settled answer\nstreaming reply')
    })
  it('takes no word from another message when a drag ends on a box column', () => {
      const model = new TranscriptModel()
      model.apply({ type: 'user/message', data: { content: [{ type: 'text', text: 'alpha' }], source: { kind: 'user' } } })
      model.apply({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'beta' }] } } })
      const view = viewOf(model)
      const beta = handedBack(view.render(40)).split('\n').find(row => row.includes('beta')) ?? ''
      // The drag covered "beta" and then landed on the box's own column: the column is
      // the frame, so it goes, and nothing of the message above takes its place.
      expect(cleanCopied([beta, '│'].join('\n'), view.copyRows())).toBe('beta')
      // A copy of frame alone is handed back, not emptied, and not answered with a word.
      expect(cleanCopied('│', view.copyRows())).toBe('│')
    })
  it('takes nothing away from a row it never drew', () => {
      const model = new TranscriptModel()
      model.apply({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'the answer' }] } } })
      const view = viewOf(model)
      view.render(40)
      expect(cleanCopied('a row from the editor', view.copyRows())).toBe('a row from the editor')
    })
})
