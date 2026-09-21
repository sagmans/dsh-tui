import { describe, expect, it } from 'vitest'
import { defaultKeymap, type Keymap } from '@/input/actions.ts'
import type { ResolvedEntry, StashEntry } from '@/stash/schema.ts'
import type { PickerAction } from '@/ui/picker.ts'
import { confirmedClear, StashConfirmPicker, StashPicker, stashLabel } from '@/ui/stash-picker.ts'

const entry = (id: string, text: string, createdAt = 1_000): StashEntry => ({ id, text, createdAt })

/** A draft with the index the bank gives it, which the row has to show. */
const row = (id: string, text: string, createdAt = 1_000, index = 0): ResolvedEntry => ({
  entry: entry(id, text, createdAt),
  index,
})

const picker = (entries: readonly ResolvedEntry[], keys: () => Keymap = defaultKeymap): StashPicker =>
  new StashPicker(entries, 'tui-session-abc', keys, () => 1_000 + 5 * 60_000)

describe('stashLabel', () => {
  it('names a draft by its first line, with whitespace collapsed', () => {
    expect(stashLabel('fix the   parser\nand then some')).toBe('fix the parser')
    expect(stashLabel('\n\nsecond line is the first with words')).toBe('second line is the first with words')
  })

  it('never leaves a row blank for a draft that is only whitespace', () => {
    expect(stashLabel('   \n\t')).toBe('(empty draft)')
  })

  it('cuts a long line so one row cannot push the rest off the card', () => {
    const label = stashLabel('x'.repeat(80))
    expect(label).toHaveLength(50)
    expect(label.endsWith('…')).toBe(true)
  })
})

describe('StashPicker', () => {
  it('heads the list with the session and the count', () => {
    const card = picker([row('a', 'one')]).card()
    expect(card.title).toBe('stash · tui-session-abc · 1 draft')
    expect(picker([row('a', 'one'), row('b', 'two')]).card().title).toBe('stash · tui-session-abc · 2 drafts')
  })

  it('describes each draft by its label and its age', () => {
    const card = picker([row('a', 'send the report', 1_000)]).card()
    expect(card.rows[0]).toMatchObject({ label: '[0] send the report', description: '5m ago', current: true })
  })

  it('picks the draft under the cursor by its id, not its index', () => {
    const list = picker([row('a', 'one'), row('b', 'two')])
    expect(list.handleKey('\u001b[B')).toBeUndefined()
    expect(list.handleKey('\r')).toEqual({ kind: 'pick', id: 'b' })
  })

  it('cancels on escape', () => {
    expect(picker([row('a', 'one')]).handleKey('\u001b')).toEqual({ kind: 'cancel' })
  })

  it('filters on the draft text, not only the shown label', () => {
    const list = picker([row('a', 'fix the parser'), row('b', 'write the docs')])
    for (const key of 'docs') list.handleKey(key)
    expect(list.visible().map(visible => visible.entry.id)).toEqual(['b'])
  })

  /**
   * Filtering hides rows, so a position in the list stops matching the bank. The
   * index is the selector the command line answers to, and it has to keep naming
   * the same draft however the list is narrowed.
   */
  it('keeps the bank index on a row filtering left alone', () => {
    const list = picker([row('a', 'fix the parser'), row('b', 'write the docs', 1_000, 1)])
    for (const key of 'docs') list.handleKey(key)
    expect(list.visible().map(visible => visible.index)).toEqual([1])
    expect(list.card().rows[0]?.label).toBe('[1] write the docs')
  })
})

describe('StashConfirmPicker', () => {
  it('offers the safe choice first, under the cursor', () => {
    const card = new StashConfirmPicker(3, defaultKeymap).card()
    expect(card.title).toBe('clear stash · 3 drafts in this session')
    expect(card.rows[0]).toMatchObject({ label: 'cancel', current: true })
    expect(card.rows[1]).toMatchObject({ label: 'delete 3 drafts' })
  })

  it('reads a single draft in the singular', () => {
    const card = new StashConfirmPicker(1, defaultKeymap).card()
    expect(card.rows[1]).toMatchObject({ label: 'delete 1 draft' })
  })

  it('answers with the destructive choice only when it is chosen', () => {
    const list = new StashConfirmPicker(2, defaultKeymap)
    expect(confirmedClear(pickedId(list.handleKey('\r')))).toBe(false)
    list.handleKey('\u001b[B')
    expect(confirmedClear(pickedId(list.handleKey('\r')))).toBe(true)
    expect(confirmedClear(undefined)).toBe(false)
  })
})

function pickedId(action: PickerAction | undefined): string | undefined {
  return action?.kind === 'pick' ? action.id : undefined
}
