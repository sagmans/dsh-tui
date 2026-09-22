import { describe, expect, it } from 'vitest'
import { type TUI } from '@earendil-works/pi-tui'
import { createTheme } from '@/theme.ts'
import { BoxedEditor } from '@/ui/editor.ts'
import { PromptBar } from '@/ui/prompt.ts'

const STUB_TUI = { requestRender: () => {}, terminal: { rows: 24, cols: 60 } } as unknown as TUI

function barOf(text = ''): { bar: PromptBar; editor: BoxedEditor } {
  const editor = new BoxedEditor(STUB_TUI, createTheme('none').editor)
  editor.setText(text)
  return { bar: new PromptBar(editor), editor }
}

describe('the prompt bar a question borrows', () => {
  it('leaves the bar in place until a question asks for it', () => {
    const { bar } = barOf('ask me later')
    expect(bar.render(60).join('\n')).toContain('ask me later')
  })

  it('hides the bar for as long as the question holds it', () => {
    const { bar } = barOf('ask me later')
    bar.borrow(() => {})
    expect(bar.render(60)).toEqual([])
  })

  it('puts the prompt back when the question is done', () => {
    const { bar, editor } = barOf('ask me later')
    bar.borrow(() => {})
    expect(editor.getText()).toBe('')
    bar.giveBack()
    expect(editor.getText()).toBe('ask me later')
    expect(bar.render(60).join('\n')).toContain('ask me later')
  })

  it('holds the prompt aside before the gate that empties the bar is built', () => {
    // A gate clears the editor for its first answer as it is built, so a bar
    // that only looked at the text afterwards would lose the prompt for good.
    const { bar, editor } = barOf('ask me later')
    bar.borrow(() => editor.setText(''))
    bar.giveBack()
    expect(editor.getText()).toBe('ask me later')
  })

  it('returns an empty bar when the prompt itself was empty', () => {
    const { bar, editor } = barOf()
    bar.borrow(() => editor.setText('an answer'))
    bar.giveBack()
    expect(editor.getText()).toBe('')
  })

  it('carries a pasted prompt back as the text it stands for', () => {
    // A block big enough to be held behind a marker, which is what the reader
    // sees in the bar: what comes back has to be the block itself, not the mark.
    const pasted = Array.from({ length: 30 }, (_, line) => `line ${line + 1}`).join('\n')
    const { bar, editor } = barOf()
    editor.handleInput(`\u001b[200~${pasted}\u001b[201~`)
    expect(editor.getText()).toMatch(/\[paste #1/)
    bar.borrow(() => {})
    bar.giveBack()
    expect(editor.getExpandedText()).toBe(pasted)
  })

  it('leaves the editor alone when no question ever borrowed it', () => {
    const { bar, editor } = barOf('ask me later')
    bar.giveBack()
    expect(editor.getText()).toBe('ask me later')
  })

  it('holds an edit that lands while the gate has the bar', () => {
    // The reader can be editing the draft in another program while an approval
    // arrives, and that edit is theirs, not the answer being collected.
    const { bar, editor } = barOf('the draft so far')
    bar.borrow(() => editor.setText('an answer'))
    bar.replaceHeld('edited outside')
    expect(editor.getText()).toBe('an answer')
    bar.giveBack()
    expect(editor.getText()).toBe('edited outside')
  })

  it('leaves the bar alone when nothing has borrowed it', () => {
    const { bar, editor } = barOf('the draft so far')
    bar.replaceHeld('edited outside')
    expect(editor.getText()).toBe('the draft so far')
  })

  it('hands a click in the bar down to the editor it draws', () => {
    const { bar, editor } = barOf('abcdef')
    const rows = bar.render(60)
    const textRow = rows.findIndex(row => row.includes('abcdef'))
    // The layout knows only the bar, so it delivers the click in the bar's own
    // rows; the editor drew them and has to answer for them.
    const result = bar.handleMouse({
      type: 'click',
      button: 'left',
      x: 1,
      y: textRow,
      screenX: 1,
      screenY: textRow,
      width: 60,
      height: rows.length,
      shift: false,
      alt: false,
      ctrl: false,
    })
    expect(result).toEqual({ handled: true, focus: true })
    expect(editor.getCursor().col).toBe(0)
  })
})
