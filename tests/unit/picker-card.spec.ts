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
    expect(rowsDrawn(tall)).toBe(popupRowBudget(48))
    expect(rowsDrawn(short)).toBe(popupRowBudget(18))
    expect(rowsDrawn(tall)).toBeGreaterThan(rowsDrawn(short))
    expect(tall.length).toBeLessThanOrEqual(popupHeight(48))
    expect(short.length).toBeLessThanOrEqual(popupHeight(18))
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
    expect(popupRowBudget(20)).toBe(popupHeight(20) - 7)
    expect(popupRowBudget(2)).toBe(3)
  })
})
