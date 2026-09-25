/**
 * Cases no existing spec owns. The credential mask is exercised through the
 * real bar, because that is the only place a reader ever sees it.
 */

import { describe, expect, it } from 'vitest'
import { visibleWidth, type TUI } from '@earendil-works/pi-tui'
import { createTheme } from '@/theme.ts'
import { GateInputBar } from '@/ui/gate-input.ts'

/** The terminal the bar renders against; nothing here reads the screen or repaints. */
const TUI_STUB = { requestRender: () => {}, terminal: { rows: 24, columns: 80 } } as unknown as TUI
const WIDTH = 60
/**
 * How much of a credential stays readable at each end.
 *
 * The module keeps these as its own private MASK_HEAD/MASK_TAIL; naming them here
 * is what lets a case state the exact row the reader gets.
 */
const MASK_HEAD = 4
const MASK_TAIL = 4
/** The reverse-video escape the base editor draws the cursor with. */
const CURSOR = '\u001b[7m'

const render = (text: string, mode: 'answer' | 'secret'): string[] => {
  const bar = new GateInputBar(TUI_STUB, createTheme('none').editor)
  bar.setMode(mode)
  bar.setText(text)
  return bar.render(WIDTH)
}

describe('maskCredentialRow', () => {
  it('shows a value no longer than the readable ends rather than masking it whole', () => {
    const text = 'abcd1234'
    expect(text.length).toBe(MASK_HEAD + MASK_TAIL)
    // Every character is an end at this length; hiding the middle would hide the
    // whole answer and leave the reader checking a row of asterisks.
    expect(render(text, 'secret')[1]).toBe(render(text, 'answer')[1])
  })

  it('keeps the first and last readable characters and masks everything between', () => {
    const text = 'sk-ant-api03-FAKE998877665544332211'
    const hidden = '*'.repeat(text.length - MASK_HEAD - MASK_TAIL)
    expect(render(text, 'secret')[1]).toContain(`sk-a${hidden}2211`)
  })

  it('masks a wide character by the columns it takes, so the row does not reflow', () => {
    const text = 'head密钥密钥tail'
    const secret = render(text, 'secret')
    const answer = render(text, 'answer')
    expect(secret[1]).toContain(`head${'*'.repeat(8)}tail`)
    expect(secret.map(visibleWidth)).toEqual(answer.map(visibleWidth))
  })

  it('leaves the spacing of a credential alone while hiding its characters', () => {
    // Whitespace is the editor's own layout, not part of the secret: masking it
    // would move the text under the cursor instead of hiding a character.
    expect(render('abcd efgh ijkl mnop', 'secret')[1]).toContain('abcd **** **** mnop')
  })

  it('keeps the cursor mark the terminal reads, which masking must not hide', () => {
    const secret = render('sk-ant-api03-FAKE998877665544332211', 'secret')[1]!
    // The cursor is an escape around a cell, not text: replacing that cell would
    // lose the position the terminal was told to place the cursor at.
    expect(secret).toContain(CURSOR)
    expect(secret.indexOf(CURSOR)).toBeGreaterThan(secret.indexOf('2211'))
  })
})
