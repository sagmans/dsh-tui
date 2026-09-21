import { describe, expect, it } from 'vitest'
import { defaultKeymap, type Keymap } from '@/input/actions.ts'
import type { StashEntry } from '@/stash/schema.ts'
import type { PickerAction } from '@/ui/picker.ts'
import { confirmedClear, StashConfirmPicker, StashPicker, stashLabel } from '@/ui/stash-picker.ts'

const entry = (id: string, text: string, createdAt = 1_000): StashEntry => ({ id, text, createdAt })

const picker = (entries: readonly StashEntry[], keys: () => Keymap = defaultKeymap): StashPicker =>
  new StashPicker(entries, '~/work/app', keys, () => 1_000 + 5 * 60_000)

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
  it('heads the list with the directory and the count', () => {
    const card = picker([entry('a', 'one')]).card()
    expect(card.title).toBe('stash · ~/work/app · 1 draft')
    expect(picker([entry('a', 'one'), entry('b', 'two')]).card().title).toBe('stash · ~/work/app · 2 drafts')
  })

  it('describes each draft by its label and its age', () => {
    const card = picker([entry('a', 'send the report', 1_000)]).card()
    expect(card.rows[0]).toMatchObject({ label: 'send the report', description: '5m ago', current: true })
  })

  it('picks the draft under the cursor by its id, not its index', () => {
    const list = picker([entry('a', 'one'), entry('b', 'two')])
    expect(list.handleKey('\u001b[B')).toBeUndefined()
    expect(list.handleKey('\r')).toEqual({ kind: 'pick', id: 'b' })
  })

  it('cancels on escape', () => {
    expect(picker([entry('a', 'one')]).handleKey('\u001b')).toEqual({ kind: 'cancel' })
  })

  it('filters on the draft text, not only the shown label', () => {
    const list = picker([entry('a', 'fix the parser'), entry('b', 'write the docs')])
    for (const key of 'docs') list.handleKey(key)
    expect(list.visible().map(row => row.id)).toEqual(['b'])
  })
})

describe('StashConfirmPicker', () => {
  it('offers the safe choice first, under the cursor', () => {
    const card = new StashConfirmPicker(3, defaultKeymap).card()
    expect(card.title).toBe('clear stash · 3 drafts in this directory')
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
