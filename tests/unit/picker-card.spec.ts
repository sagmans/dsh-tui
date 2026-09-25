import { describe, expect, it } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'
import { createTheme } from '@/theme.ts'
import { pickerCardLines, PickerPopup, popupHeight, popupRowBudget, popupWidth } from '@/ui/picker-card.ts'
import type { PickerCard } from '@/ui/picker.ts'

const theme = createTheme('none')

const card = (overrides: Partial<PickerCard> = {}): PickerCard => ({
  title: 'sessions',
  note: undefined,
  rows: [
    { label: 'one', description: 'work', current: true },
    { label: 'two', description: undefined, current: false },
  ],
  above: 3,
  below: 4,
  filter: '',
  hint: 'enter open · esc cancel',
  ...overrides,
})

/** A list long enough to need a window, cursor on its first row. */
const many = (count: number): PickerCard['rows'] =>
  Array.from({ length: count }, (_, index) => ({ label: `row ${index}`, description: undefined, current: index === 0 }))

const rowsDrawn = (lines: readonly string[]): number => lines.filter(line => line.includes('row ')).length

const popup = (
  terminalRows: number,
  source: (budget: number) => PickerCard | undefined = budget => card({ rows: many(budget), above: 0, below: 0 }),
): PickerPopup => new PickerPopup(source, () => terminalRows, theme)

describe('pickerCardLines', () => {
  it('draws the heading, the filter, the window, and the hint at the width it is given', () => {
    const lines = pickerCardLines(card({ filter: 'se' }), 40, theme)
    expect(lines).toEqual([
      'sessions',
      '    filter: se',
      '   … 3 newer',
      '   ❯ one — work',
      '     two',
      '   … 4 older',
      '   enter open · esc cancel',
    ])
    expect(lines.every(line => visibleWidth(line) <= 40)).toBe(true)
  })

  it('draws no row at all when the list has none', () => {
    expect(pickerCardLines(card({ rows: [], above: 0, below: 0 }), 40, theme)).toEqual([
      'sessions',
      '   enter open · esc cancel',
    ])
  })

  it('folds the picker keys under a narrow screen instead of cutting the way out off', () => {
    // The hint is how a reader learns to leave the list, so a narrow screen folds
    // it rather than dropping the keys a press still answers.
    const lines = pickerCardLines(card({
      rows: [{ label: 'fix the parser', description: '/work · 3m ago', current: true }],
      hint: '↑/ctrl+p or ↓/ctrl+n move · enter open · esc/ctrl+c cancel · type to filter',
      filter: '',
      above: 0,
      below: 0,
    }), 40, theme)
    const hint = lines.join(' ').replace(/\s+/gu, ' ')
    expect(hint).toContain('esc/ctrl+c cancel')
    expect(hint).toContain('type to filter')
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40)
  })

  it('wraps the reason a pick was refused under the heading', () => {
    // A reason that does not fit has to keep going rather than be cut off: the
    // reader is being told why the thing they picked did not happen.
    const lines = pickerCardLines(card({
      title: 'resume a session · 1 stored',
      note: 'session tui-session-a runs mode "cordis", so --preset standard does not apply; /preset standard switches it before its first turn',
      rows: [{ label: 'tui-session-a', description: '/work · 3m ago', current: true }],
      filter: '',
      above: 0,
      below: 0,
    }), 60, theme)
    const heading = lines.findIndex(line => line.includes('resume a session'))
    const row = lines.findIndex(line => line.includes('❯ tui-session-a'))
    const note = lines.slice(heading + 1, row).join(' ').replace(/\s+/gu, ' ')
    expect(note).toContain('session tui-session-a runs mode "cordis"')
    expect(note).toContain('switches it before its first turn')
    expect(lines[heading + 1]?.length).toBeLessThanOrEqual(60)
  })
})

describe('PickerPopup', () => {
  it('draws the card inside a frame as wide as it was given', () => {
    const lines = popup(40).render(60)
    expect(lines[0]?.startsWith('╭')).toBe(true)
    expect(lines.at(-1)?.startsWith('╰')).toBe(true)
    expect(lines.some(line => line.includes('❯ row 0'))).toBe(true)
    expect(lines.every(line => visibleWidth(line) <= 60)).toBe(true)
  })

  it('asks the list for as many rows as the terminal can afford, not for the whole list', () => {
    const tall = popup(48).render(60)
    const short = popup(18).render(60)
    expect(rowsDrawn(tall)).toBe(31)
    expect(rowsDrawn(short)).toBe(7)
    expect(tall.length).toBeLessThanOrEqual(38)
    expect(short.length).toBeLessThanOrEqual(14)
  })

  it('draws nothing once the list is gone', () => {
    expect(new PickerPopup(() => undefined, () => 40, theme).render(60)).toEqual([])
  })

  it('shrinks the window rather than lose the closing rule to a note that wraps', () => {
    // A refusal note is the one field whose height the budget cannot guess, so
    // the box gives up rows rather than let the library slice its own frame off.
    const lines = new PickerPopup(
      budget => card({ note: 'x'.repeat(400), rows: many(budget), above: 0, below: 0 }),
      () => 20,
      theme,
    ).render(60)
    expect(lines.length).toBeLessThanOrEqual(popupHeight(20))
    expect(lines.at(-1)?.startsWith('╰')).toBe(true)
  })

  it('keeps the box narrow on a wide terminal, and clamps outside a narrow one', () => {
    expect(popupWidth(200)).toBe(100)
    expect(popupWidth(50)).toBe(48)
    expect(popupWidth(20)).toBe(40)
  })

  it('reserves the box its frame and its hint before the rows', () => {
    expect(popupRowBudget(20)).toBe(9)
    expect(popupRowBudget(2)).toBe(3)
  })
})
