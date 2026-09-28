/**
 * The view as the coordinator the surface renders through: theme revisions
 * that invalidate cached rows, and what copy takes from a
 * transcript that the other view suites never assemble.
 */

import { describe, expect, it } from 'vitest'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { createTheme, forwardEditorTheme, forwardMarkdownTheme, type TuiTheme } from '@/theme.ts'
import { DEFAULT_PALETTE } from '@/theme-defaults.ts'
import { TranscriptModel } from '@/transcript.ts'
import { cleanCopied } from '@/ui/copy.ts'
import { MarkdownRenderer } from '@/ui/markdown.ts'
import { TranscriptView } from '@/ui/view.ts'
import { COLLAPSED, viewOf } from './fixtures/transcript-view.ts'

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
  /**
   * The rows a drag over a message hands back: styling gone, trailing blanks gone.
   *
   * The surface's own rows of air are left out, because a drag that starts on a
   * box does not cover them; a selection that does cross one keeps it, which the
   * case below pins.
   */
    const handedBack = (rows: readonly string[]): string => rows
      .map(row => stripTerminalSequences(row).trimEnd())
      .filter(row => row !== '')
      .join('\n')
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
  it("hands back a selection that crossed the surface's own air", () => {
      const model = new TranscriptModel()
      model.apply({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'the answer' }] } } })
      const view = viewOf(model)
      // The air is the surface's row and no message's, so a selection that covered
      // it reads the way the terminal handed it back rather than as a word from a
      // neighbour that happened to sit beside it.
      expect(cleanCopied('\nthe answer\n', view.copyRows())).toBe('\nthe answer\n')
    })
  it('takes nothing away from a row it never drew', () => {
      const model = new TranscriptModel()
      model.apply({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'the answer' }] } } })
      const view = viewOf(model)
      view.render(40)
      expect(cleanCopied('a row from the editor', view.copyRows())).toBe('a row from the editor')
    })
})
