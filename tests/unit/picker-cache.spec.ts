/** Navigation must not repeat unchanged ranking; late source text and replacement rows stay current. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultKeymap } from '@/input/actions.ts'
import * as scoring from '@/input/match.ts'
import { ListPicker } from '@/ui/picker.ts'

const ENTER = '\r'
const DOWN = '\x1b[B'
const CANDIDATE_COUNT = 30
interface Row { readonly id: string; readonly label: string }

function picker(source: () => readonly Row[], haystack: (row: Row) => string = row => row.label): ListPicker<Row> {
  return new ListPicker(source, () => 'rows', row => row.id,
    row => ({ label: row.label, description: undefined, current: false }), haystack,
    { empty: () => 'empty', listed: () => 'listed' }, defaultKeymap, 'needle')
}

afterEach(() => vi.restoreAllMocks())

describe('picker ranking retention', () => {
  it('spends no ranking passes on unchanged navigation and repaint', () => {
    const rows = Array.from({ length: CANDIDATE_COUNT }, (_, id) => ({ id: String(id), label: `needle ${id}` }))
    const list = picker(() => rows)
    const rank = vi.spyOn(scoring, 'matchScore')
    list.card()
    rank.mockClear()
    list.handleKey(DOWN)
    list.card()
    list.card()

    expect(rank).not.toHaveBeenCalled()
    expect(list.card().rows.find(row => row.current)?.label).toBe('needle 1')
  })

  it('refreshes ranks when a late title changes despite retaining the source array', () => {
    const rows = [{ id: 'one', label: 'other' }, { id: 'two', label: 'needle' }]
    let titles = new Map(rows.map(row => [row.id, row.label]))
    const list = picker(() => rows, row => titles.get(row.id) ?? row.label)
    expect(list.handleKey(ENTER)).toEqual({ kind: 'pick', id: 'two' })
    titles = new Map([['one', 'needle'], ['two', 'other']])
    expect(list.handleKey(ENTER)).toEqual({ kind: 'pick', id: 'one' })
  })

  it('retains rank indices, not obsolete source rows with the same matching text', () => {
    let rows = [{ id: 'old', label: 'needle' }]
    const list = picker(() => rows)
    list.card()
    rows = [{ id: 'replacement', label: 'needle' }]
    expect(list.handleKey(ENTER)).toEqual({ kind: 'pick', id: 'replacement' })
    rows = []
    expect(list.card().rows).toEqual([])
    expect(list.handleKey(ENTER)).toBeUndefined()
  })
})
